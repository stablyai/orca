// The relay answers `exited` from one place: the exit it observed and its owner has not received
// yet. There is no second copy and no expiry, so a laptop that reconnects an hour later still gets
// the verdict, and nothing that merely tore a record down can produce one.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as ptyShellUtils from './pty-shell-utils'
import {
  PTY_ATTACH_PROVEN_EXITED_MARKER,
  isProvenExitedPtyAttachRefusal
} from '../shared/pty-attach-absence-evidence'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    process: 'zsh',
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  createTestPtyHandler,
  endPtyHandlerTest,
  testPtyId,
  type MockDispatcher
} from './pty-handler-test-harness'

const PTY_1 = testPtyId(1)

type ExitEvidence = {
  foregroundProcessEvidence?: {
    verdict: string
    reason?: string
    ptyIncarnationId?: string
  }
}

describe('relay exit evidence', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let exitCallback: ((info: { exitCode: number }) => void) | undefined

  const { spawnPty, attachPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    exitCallback = undefined
    mockPtySpawn.mockImplementation(() => ({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((callback: (info: { exitCode: number }) => void) => {
        exitCallback = callback
      })
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  /** Rebuild the handler with a legacy writer that refuses, i.e. the owning client is away. */
  function withAbsentOwner(): { capacity: () => void } {
    let capacityListener: (() => void) | undefined
    let accepting = false
    Object.assign(dispatcher, {
      onLegacyPtyCapacity: vi.fn((listener: () => void) => {
        capacityListener = listener
        return vi.fn()
      }),
      tryNotifyPtyData: vi.fn(() => true),
      tryNotifyPtyExit: vi.fn(() => accepting),
      legacyRetentionBelowLowWater: true
    })
    handler = createTestPtyHandler(dispatcher)
    return {
      capacity: () => {
        accepting = true
        capacityListener?.()
      }
    }
  }

  function inspect(params: Record<string, unknown>): Promise<ExitEvidence> {
    return dispatcher.callRequest('pty.inspectProcess', params) as Promise<ExitEvidence>
  }

  it('answers exited for the stored incarnation long after the owner disconnected', async () => {
    const owner = withAbsentOwner()
    const { incarnationId } = await spawnPty()

    exitCallback?.({ exitCode: 3 })
    // Well past the 5s window the retired-incarnation tombstone used to impose.
    await vi.advanceTimersByTimeAsync(600_000)

    expect(await inspect({ id: PTY_1, expectedIncarnationId: incarnationId })).toMatchObject({
      foregroundProcessEvidence: {
        verdict: 'exited',
        reason: 'pty_exit_3',
        ptyIncarnationId: incarnationId
      }
    })

    // The reconnect delivers it; after that the client holds the exit and the relay says nothing.
    owner.capacity()
    await expect(inspect({ id: PTY_1, expectedIncarnationId: incarnationId })).rejects.toThrow(
      'terminal_gone'
    )
  })

  it('spells an ESRCH death as an unknown status rather than a fabricated code', async () => {
    withAbsentOwner()
    const { incarnationId } = await spawnPty()
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)

    // The listing probe is the reachable ESRCH path: a shell that exited without node-pty's onExit.
    await dispatcher.callRequest('pty.listProcesses', {
      includeForegroundProcessEvidence: false
    })

    expect(await inspect({ id: PTY_1, expectedIncarnationId: incarnationId })).toMatchObject({
      foregroundProcessEvidence: {
        verdict: 'exited',
        reason: 'pty_exit_status_unknown'
      }
    })
  })

  it('says nothing once the exit reached the owner', async () => {
    const { incarnationId } = await spawnPty()

    exitCallback?.({ exitCode: 0 })
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.exit', {
      id: PTY_1,
      code: 0,
      incarnationId
    })

    await expect(inspect({ id: PTY_1, expectedIncarnationId: incarnationId })).rejects.toThrow(
      'terminal_gone'
    )
  })

  it('refuses to answer a caller that named no incarnation or a different one', async () => {
    withAbsentOwner()
    await spawnPty()

    exitCallback?.({ exitCode: 0 })

    await expect(inspect({ id: PTY_1 })).rejects.toThrow('terminal_gone')
    await expect(
      inspect({
        id: PTY_1,
        expectedIncarnationId: '11111111-1111-4111-8111-111111111111'
      })
    ).rejects.toThrow('terminal_gone')
  })

  it('never answers for an id the relay never minted', async () => {
    withAbsentOwner()
    const { incarnationId } = await spawnPty()
    exitCallback?.({ exitCode: 0 })

    // A restarted relay renumbers, and legacy hosts minted bare `pty-N`. Neither is this exit.
    for (const id of ['pty-1', 'pty2:other-mint-epoch:1', testPtyId(9)]) {
      await expect(inspect({ id, expectedIncarnationId: incarnationId })).rejects.toThrow(
        'terminal_gone'
      )
    }
  })

  it('marks an attach refusal only when it holds that incarnation exit', async () => {
    withAbsentOwner()
    const { incarnationId } = await spawnPty()

    exitCallback?.({ exitCode: 0 })

    const marked = await attachPty({
      id: PTY_1,
      expectedIncarnationId: incarnationId
    }).catch((error: Error) => error)
    expect((marked as Error).message).toContain(PTY_ATTACH_PROVEN_EXITED_MARKER)
    expect(isProvenExitedPtyAttachRefusal(marked)).toBe(true)

    // Without the incarnation the answer is the ambiguous "no such id" union, unchanged.
    const unmarked = await attachPty({ id: PTY_1 }).catch((error: Error) => error)
    expect(isProvenExitedPtyAttachRefusal(unmarked)).toBe(false)
    expect((unmarked as Error).message).toBe(`PTY "${PTY_1}" not found`)
  })

  it('does not attribute a held exit to the incarnation that replaced it', async () => {
    withAbsentOwner()
    const { incarnationId: retired } = await spawnPty()
    exitCallback?.({ exitCode: 0 })

    const state = JSON.stringify([
      { id: PTY_1, pid: process.pid, cols: 80, rows: 24, cwd: process.cwd() }
    ])
    await dispatcher.callRequest('pty.revive', { state })
    const revived = (
      (await dispatcher.callRequest('pty.listProcesses', {
        includeForegroundProcessEvidence: false
      })) as { id: string; incarnationId: string }[]
    ).find((entry) => entry.id === PTY_1)
    expect(revived?.incarnationId).not.toBe(retired)

    // The live record answers for itself, and the held exit answers for nobody but its own
    // incarnation — which no longer owns this id.
    expect(await inspect({ id: PTY_1, expectedIncarnationId: retired })).toMatchObject({
      foregroundProcessEvidence: {
        verdict: 'unverifiable',
        reason: 'incarnation_mismatch'
      }
    })
    expect(
      (
        await inspect({
          id: PTY_1,
          expectedIncarnationId: revived?.incarnationId
        })
      ).foregroundProcessEvidence?.verdict
    ).not.toBe('exited')
  })

  it('writes no death when the sweep drops a record we tore down ourselves', async () => {
    withAbsentOwner()
    const { incarnationId } = await spawnPty()
    // State-space, not a user path: nothing today leaves a disposed record in the pool. The sweep
    // branch exists for it, and this pins that it retires bookkeeping without certifying a death.
    const managed = (
      handler as unknown as {
        ptys: Map<string, { disposed: boolean; physicalExit: { markExited: () => void } }>
      }
    ).ptys.get(PTY_1)!
    managed.disposed = true
    const markExited = vi.spyOn(managed.physicalExit, 'markExited')

    await dispatcher.callRequest('pty.listProcesses', {
      includeForegroundProcessEvidence: false
    })

    expect(handler.activePtyCount).toBe(0)
    // Not even the internal "this process ended" flag: a shutdown waiting on it would read our own
    // bookkeeping as the host's observation.
    expect(markExited).not.toHaveBeenCalled()
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.exit', expect.anything())
    await expect(inspect({ id: PTY_1, expectedIncarnationId: incarnationId })).rejects.toThrow(
      'terminal_gone'
    )
  })

  it('leaves a shutdown that timed out unverifiable, with a sibling still serving', async () => {
    withAbsentOwner()
    const { incarnationId } = await spawnPty()
    const failedKill = vi.fn<() => void>(() => {
      throw new Error('host refused kill')
    })
    mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, kill: failedKill })
    await spawnPty()

    const disposal = handler.dispose().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(8_001)
    expect(await disposal).toMatchObject({ message: 'host refused kill' })
    failedKill.mockImplementation(() => {})

    expect(() => process.kill(process.pid, 0)).not.toThrow()
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.exit', expect.anything())
    await expect(inspect({ id: PTY_1, expectedIncarnationId: incarnationId })).rejects.toThrow(
      'terminal_gone'
    )
  })
})
