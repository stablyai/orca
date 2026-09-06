import { describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/types'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { ResourceReservationRequest } from '../../shared/resource-reservation-binding'
import { OrcaRuntimeService } from './orca-runtime'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'
import { TerminalReservationBindings } from './terminal-reservation-bindings'

type CreateRun = (
  canonicalWorktreeSelector: string | undefined,
  preAllocatedHandle: string | undefined
) => Promise<RuntimeTerminalCreate>

const RESERVATION: ResourceReservationRequest = {
  key: 'key-1',
  reservationId: 'res-1',
  sessionId: 'session-1',
  resourceKind: 'terminal',
  ownershipGeneration: 2,
  issuer: 'openloop'
}

function createRuntimeForDedupe(listProcesses = vi.fn(async (): Promise<PtyProcessInfo[]> => [])) {
  const runtime = Object.create(OrcaRuntimeService.prototype) as OrcaRuntimeService
  Object.assign(runtime, {
    terminalCreateIdempotency: new RemoteRuntimeTerminalCreateIdempotency(),
    terminalReservations: new TerminalReservationBindings(),
    ptyController: { listProcesses },
    resolveTerminalWorkspaceLaunchScope: vi.fn(async (selector: string) => ({
      id: selector.startsWith('id:') ? selector.slice(3) : selector
    }))
  })
  return runtime
}

function createdTerminal(handle: string, worktreeId = 'worktree-1'): RuntimeTerminalCreate {
  return { handle, worktreeId, title: null }
}

describe('terminal create reservation binding', () => {
  it('addresses the terminal by the reservation key so a retry re-derives one handle', async () => {
    const runtime = createRuntimeForDedupe()
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )

    const first = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      undefined,
      false,
      create,
      RESERVATION
    )

    expect(first.handle).toBe(
      deriveRemoteRuntimeTerminalCreateHandle('reservation:openloop', 'worktree-1', 'key-1')
    )
    expect(first.reservation).toMatchObject(RESERVATION)
    expect(typeof first.reservation?.boundAt).toBe('number')
  })

  it('uses the same reservation address and one create across changed transports', async () => {
    const runtime = createRuntimeForDedupe()
    let releaseCreate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const create = vi.fn<CreateRun>(async (_selector, handle) => {
      await gate
      return createdTerminal(handle ?? 'missing')
    })

    const first = runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      false,
      create,
      RESERVATION
    )
    const reconnect = runtime.dedupeTerminalCreate(
      'device-b',
      'id:worktree-1',
      'mutation-2',
      false,
      create,
      RESERVATION
    )
    releaseCreate()

    const [created, replayed] = await Promise.all([first, reconnect])
    expect(replayed.handle).toBe(created.handle)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('ignores a fresh transport mutation id so a reserved retry is not a second terminal', async () => {
    const runtime = createRuntimeForDedupe()
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )

    const first = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      false,
      create,
      RESERVATION
    )
    const retry = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-2',
      false,
      create,
      RESERVATION
    )

    expect(retry.handle).toBe(first.handle)
    expect(retry.reservation).toEqual(first.reservation)
  })

  it('refuses a reused key whose ownership generation moved on', async () => {
    const runtime = createRuntimeForDedupe()
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )
    await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      undefined,
      false,
      create,
      RESERVATION
    )

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', undefined, false, create, {
        ...RESERVATION,
        ownershipGeneration: 3
      })
    ).rejects.toMatchObject({ code: 'reservation_conflict' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refuses the same key aimed at a second workspace instead of binding twice', async () => {
    const runtime = createRuntimeForDedupe()
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )
    await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      undefined,
      false,
      create,
      RESERVATION
    )

    await expect(
      runtime.dedupeTerminalCreate(
        'device-a',
        'id:worktree-2',
        undefined,
        false,
        create,
        RESERVATION
      )
    ).rejects.toMatchObject({ code: 'reservation_conflict' })
  })

  it('leaves the key unused after a failed create so a genuine retry starts fresh', async () => {
    const runtime = createRuntimeForDedupe()
    const failing = vi.fn<CreateRun>(async () => {
      throw new Error('spawn_failed')
    })
    const succeeding = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )

    await expect(
      runtime.dedupeTerminalCreate(
        'device-a',
        'id:worktree-1',
        undefined,
        false,
        failing,
        RESERVATION
      )
    ).rejects.toThrow('spawn_failed')

    const retry = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      undefined,
      false,
      succeeding,
      RESERVATION
    )

    expect(retry.reservation).toMatchObject(RESERVATION)
  })

  it('preserves both the create and reservation-release errors when cleanup also fails', async () => {
    const runtime = createRuntimeForDedupe()
    const createError = new Error('spawn_failed')
    const releaseError = new Error('reservation_release_persist_failed')
    const failing = vi.fn<CreateRun>(async () => {
      throw createError
    })
    const release = vi
      .spyOn(
        (runtime as unknown as { terminalReservations: TerminalReservationBindings })
          .terminalReservations,
        'release'
      )
      .mockImplementation(() => {
        throw releaseError
      })

    const rejected = await runtime
      .dedupeTerminalCreate('device-a', 'id:worktree-1', undefined, false, failing, RESERVATION)
      .catch((error: unknown) => error)

    expect(release).toHaveBeenCalledOnce()
    expect(rejected).toBeInstanceOf(AggregateError)
    expect((rejected as AggregateError).errors).toEqual([createError, releaseError])
  })

  it('refuses a reserved create with no workspace rather than creating an unbound terminal', async () => {
    const runtime = createRuntimeForDedupe()
    const create = vi.fn<CreateRun>(async () => createdTerminal('term_x'))

    await expect(
      runtime.dedupeTerminalCreate('device-a', undefined, undefined, false, create, RESERVATION)
    ).rejects.toThrow('invalid_argument')
    expect(create).not.toHaveBeenCalled()
  })

  it('leaves an unreserved create with no binding on the result', async () => {
    const runtime = createRuntimeForDedupe()
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )

    const created = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      false,
      create
    )

    expect(created.reservation).toBeUndefined()
  })
})
