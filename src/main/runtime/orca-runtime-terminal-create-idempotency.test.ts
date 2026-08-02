import { describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/types'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'

type CreateRun = (
  canonicalWorktreeSelector: string | undefined,
  preAllocatedHandle: string | undefined
) => Promise<RuntimeTerminalCreate>

function createRuntimeForDedupe(listProcesses = vi.fn(async (): Promise<PtyProcessInfo[]> => [])) {
  const handleByPtyId = new Map<string, string>()
  const runtime = Object.create(OrcaRuntimeService.prototype) as OrcaRuntimeService
  Object.assign(runtime, {
    terminalCreateIdempotency: new RemoteRuntimeTerminalCreateIdempotency(),
    ptyController: { listProcesses },
    resolveTerminalWorkspaceLaunchScope: vi.fn(async (selector: string) => ({
      id: selector.startsWith('id:') ? selector.slice(3) : selector
    })),
    adoptControllerTerminalHandle: vi.fn((ptyId: string, handle: string) => {
      handleByPtyId.set(ptyId, handle)
    }),
    recordPtyWorktree: vi.fn((ptyId: string, worktreeId: string, state: { title?: string }) => ({
      ptyId,
      worktreeId,
      title: state.title ?? null
    })),
    issuePtyHandle: vi.fn((pty: { ptyId: string }) => handleByPtyId.get(pty.ptyId))
  })
  return { runtime, listProcesses }
}

function createdTerminal(handle: string, worktreeId = 'worktree-1'): RuntimeTerminalCreate {
  return { handle, worktreeId, title: null }
}

describe('terminal create idempotency', () => {
  it('derives a stable handle isolated by authenticated client and canonical worktree', () => {
    const first = deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')

    expect(deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')).toBe(
      first
    )
    expect(
      deriveRemoteRuntimeTerminalCreateHandle('device-b', 'worktree-1', 'mutation-1')
    ).not.toBe(first)
    expect(
      deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-2', 'mutation-1')
    ).not.toBe(first)
    expect(first).toMatch(/^term_[0-9a-f]{32}$/)
  })

  it('shares an in-flight create without scanning inventory on the initial request', async () => {
    const { runtime, listProcesses } = createRuntimeForDedupe()
    let resolveCreate: (value: RuntimeTerminalCreate) => void = () => {}
    const pending = new Promise<RuntimeTerminalCreate>((resolve) => {
      resolveCreate = resolve
    })
    const create = vi.fn<CreateRun>(() => pending)

    const first = runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      false,
      create
    )
    const retry = runtime.dedupeTerminalCreate(
      'device-a',
      'worktree-1',
      'mutation-1',
      false,
      create
    )
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const stableHandle = create.mock.calls[0][1]
    resolveCreate(createdTerminal(stableHandle ?? 'missing'))

    await expect(Promise.all([first, retry])).resolves.toEqual([
      createdTerminal(stableHandle ?? 'missing'),
      createdTerminal(stableHandle ?? 'missing')
    ])
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it('adopts the original PTY after a runtime-process restart without rerunning startup', async () => {
    const liveSessions: PtyProcessInfo[] = []
    const firstRuntime = createRuntimeForDedupe(vi.fn(async () => liveSessions)).runtime
    const secondInventory = vi.fn(async () => liveSessions)
    const secondRuntime = createRuntimeForDedupe(secondInventory).runtime
    const startup = vi.fn<CreateRun>(async (_selector, handle) => {
      liveSessions.push({
        id: 'worktree-1@@session-a',
        cwd: '/workspace',
        title: 'pwsh',
        worktreeId: 'worktree-1',
        terminalHandle: handle
      })
      return createdTerminal(handle ?? 'missing')
    })

    const first = await firstRuntime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      false,
      startup
    )
    const retrySpawn = vi.fn<CreateRun>()
    const recovered = await secondRuntime.dedupeTerminalCreate(
      'device-a',
      'worktree-1',
      'mutation-1',
      true,
      retrySpawn
    )

    expect(recovered.handle).toBe(first.handle)
    expect(recovered.ptyId).toBe('worktree-1@@session-a')
    expect(startup).toHaveBeenCalledTimes(1)
    expect(retrySpawn).not.toHaveBeenCalled()
    expect(secondInventory).toHaveBeenCalledTimes(1)
  })

  it('creates with the same stable handle after authoritative inventory proves absence', async () => {
    const { runtime, listProcesses } = createRuntimeForDedupe()
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )

    const result = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      true,
      create
    )

    expect(listProcesses).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('id:worktree-1', result.handle)
  })

  it('fails safely without spawning when retry inventory is unavailable', async () => {
    const listProcesses = vi.fn(async (): Promise<PtyProcessInfo[]> => {
      throw new Error('controller offline')
    })
    const { runtime } = createRuntimeForDedupe(listProcesses)
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).rejects.toThrow('runtime_unavailable')
    expect(create).not.toHaveBeenCalled()
  })

  it('fails safely when an older provider omits identity for a live same-worktree PTY', async () => {
    const { runtime } = createRuntimeForDedupe(
      vi.fn(async () => [
        {
          id: 'worktree-1@@legacy-session',
          cwd: '/workspace',
          title: 'shell',
          worktreeId: 'worktree-1'
        }
      ])
    )
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).rejects.toThrow('runtime_unavailable')
    expect(create).not.toHaveBeenCalled()
  })

  it('adopts an exact identity even when another legacy PTY lacks metadata', async () => {
    const handle = deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')
    const { runtime } = createRuntimeForDedupe(
      vi.fn(async () => [
        {
          id: 'worktree-1@@legacy-session',
          cwd: '/workspace',
          title: 'shell',
          worktreeId: 'worktree-1'
        },
        {
          id: 'worktree-1@@created-session',
          cwd: '/workspace',
          title: 'pwsh',
          worktreeId: 'worktree-1',
          terminalHandle: handle
        }
      ])
    )

    await expect(
      runtime.dedupeTerminalCreate(
        'device-a',
        'id:worktree-1',
        'mutation-1',
        true,
        vi.fn<CreateRun>()
      )
    ).resolves.toMatchObject({ handle, ptyId: 'worktree-1@@created-session' })
  })

  it('fails closed when a matching handle belongs to another worktree', async () => {
    const handle = deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')
    const { runtime } = createRuntimeForDedupe(
      vi.fn(async () => [
        {
          id: 'worktree-2@@session-a',
          cwd: '/other',
          title: 'shell',
          worktreeId: 'worktree-2',
          terminalHandle: handle
        }
      ])
    )
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).rejects.toThrow('terminal_create_identity_conflict')
    expect(create).not.toHaveBeenCalled()
  })

  it('bounds concurrent creates and releases capacity after settlement', async () => {
    const idempotency = new RemoteRuntimeTerminalCreateIdempotency(1)
    let resolveFirst: (value: RuntimeTerminalCreate) => void = () => {}
    const first = idempotency.run(
      'device-a',
      'worktree-1',
      'mutation-1',
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )

    await expect(
      idempotency.run('device-a', 'worktree-1', 'mutation-2', async () =>
        createdTerminal('terminal-2')
      )
    ).rejects.toThrow('Too many terminal creations')
    resolveFirst(createdTerminal('terminal-1'))
    await first
    await expect(
      idempotency.run('device-a', 'worktree-1', 'mutation-2', async () =>
        createdTerminal('terminal-2')
      )
    ).resolves.toEqual(createdTerminal('terminal-2'))
  })
})
