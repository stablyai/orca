import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'
import type { PtyHandler } from './pty-handler'
import type { RelayPtySourcePublication } from './relay-pty-source-publication'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe, sweep } = vi.hoisted(
  () => ({
    mockPtySpawn: vi.fn(),
    mockCreateShellPromptReadinessProbe: vi.fn(),
    sweep:
      vi.fn<
        (pid: number, killRoot: () => void, deps?: { ownsRoot?: () => boolean }) => Promise<void>
      >(),
    mockPtyInstance: {
      pid: process.pid,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn()
    }
  })
)
vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty-descendant-termination', () => ({ killWithDescendantSweep: sweep }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: (_pid: number, kill: () => void) => kill()
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

const ensure = {
  claim: {
    digestVersion: 1,
    keyId: 'claim-key',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'omp'
  },
  surface: {
    worktreeId: 'repo::/tmp/worktree',
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    terminalHandle: 'term_omp'
  }
}

describe('relay immediate descendant cleanup', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let exit: ((event: { exitCode: number }) => void) | undefined
  let release: (() => void) | undefined
  let kill: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    exit = undefined
    release = undefined
    kill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill,
      onExit: (callback: (event: { exitCode: number }) => void) => {
        exit = callback
      }
    })
    sweep.mockReset()
    sweep.mockImplementation(
      (_pid, killRoot) =>
        new Promise<void>((resolve, reject) => {
          release = () => {
            try {
              killRoot()
              resolve()
            } catch (error) {
              reject(error)
            }
          }
        })
    )
  })
  afterEach(async () => {
    release?.()
    exit?.({ exitCode: 137 })
    await endPtyHandlerTest(handler, originalPlatform)
  })

  async function spawn(params: Record<string, unknown> = {}) {
    const result = await dispatcher.callRequest('pty.spawn', params)
    if (
      !result ||
      typeof result !== 'object' ||
      !('id' in result) ||
      typeof result.id !== 'string'
    ) {
      throw new Error('missing PTY id')
    }
    return result.id
  }
  const close = (id: string) => dispatcher.callRequest('pty.shutdown', { id, immediate: true })

  it('sweeps a typed agent before force-kill and joins close through physical exit', async () => {
    const id = await spawn()
    const first = close(id)
    const second = close(id)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(kill).not.toHaveBeenCalled()
    await expect(dispatcher.callRequest('pty.attach', { id })).rejects.toThrow('terminating')
    release?.()
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith('SIGKILL'))
    expect(handler.activePtyCount).toBe(1)
    exit?.({ exitCode: 137 })
    await Promise.all([first, second])
    expect(handler.activePtyCount).toBe(0)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('does not signal a root that exits while its snapshot is pending', async () => {
    const id = await spawn()
    const closing = close(id)
    const ownsRoot = sweep.mock.calls[0]?.[2]?.ownsRoot
    expect(ownsRoot?.()).toBe(true)
    exit?.({ exitCode: 0 })
    expect(ownsRoot?.()).toBe(false)
    release?.()
    await closing
    expect(kill).not.toHaveBeenCalled()
  })

  it('retains the agent claim instead of adopting or duplicating a closing owner', async () => {
    const id = await spawn({ agentSessionEnsure: ensure })
    const closing = close(id)
    await expect(spawn({ agentSessionEnsure: ensure })).rejects.toThrow('terminating')
    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
    release?.()
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    exit?.({ exitCode: 137 })
    await closing
  })

  it('does not replay a completed create operation while its owner is closing', async () => {
    const params = {
      agentSessionEnsure: ensure,
      agentSessionCreateOperationId: 'ccccccccccccccccccccccccccccccccccccccccccc'
    }
    const id = await spawn(params)
    const closing = close(id)
    await expect(spawn(params)).rejects.toThrow('terminating')
    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
    release?.()
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    exit?.({ exitCode: 137 })
    await closing
  })

  it('allows retry after a failed root signal without releasing the live PTY', async () => {
    const id = await spawn()
    kill.mockImplementationOnce(() => {
      throw new Error('signal refused')
    })
    const rejected = expect(close(id)).rejects.toThrow('signal refused')
    release?.()
    await rejected
    expect(handler.activePtyCount).toBe(1)
    const retry = close(id)
    expect(sweep).toHaveBeenCalledTimes(2)
    release?.()
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(2))
    exit?.({ exitCode: 137 })
    await retry
  })

  it('keeps the Windows force-kill path and fences attachment until physical exit', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const id = await spawn()
    const closing = close(id)
    expect(sweep).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith()
    await expect(dispatcher.callRequest('pty.attach', { id })).rejects.toThrow('terminating')
    exit?.({ exitCode: 137 })
    await closing
  })

  it('keeps graceful shell shutdown off the descendant sweep', async () => {
    const id = await spawn()
    await dispatcher.callRequest('pty.shutdown', { id, immediate: false })
    expect(sweep).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })
  it('refuses attach after close completes during source checkpoint wait', async () => {
    const id = await spawn()
    let finishSource!: (ready: boolean) => void
    const sourceWait = new Promise<boolean>((resolve) => {
      finishSource = resolve
    })
    const activate = vi.fn(() => false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This stub supplies every publication method exercised by the handler.
    handler.setSourcePublication({
      accepts: () => false,
      exitPublicationSettled: () => true,
      sealAndPublishExit: () => false,
      publish: () => false,
      onCreditAvailable: () => {},
      receivingActivation: () => undefined,
      waitForPendingSend: () => sourceWait,
      activate,
      getDebugSnapshot: () => ({}),
      dispose: () => {}
    } as unknown as RelayPtySourcePublication)
    const attaching = dispatcher.callRequest('pty.attach', {
      id,
      sourceRecovery: {
        status: 'checkpoint',
        deliveryToken: 'token',
        ptyIncarnation: 'incarnation',
        clientGeneration: 1,
        ownerGeneration: 1,
        acceptedSourceEndSu: 0
      }
    })
    const closing = close(id)
    release?.()
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    exit?.({ exitCode: 137 })
    await closing
    expect(handler.activePtyCount).toBe(0)
    finishSource(true)
    await expect(attaching).rejects.toThrow()
    expect(activate).not.toHaveBeenCalled()
  })

  it('retains claim if close starts before initial claim liveness validation', async () => {
    let closing: Promise<unknown> | undefined
    let closeId = ''
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This stub supplies every publication method exercised by the handler.
    handler.setSourcePublication({
      accepts: () => false,
      exitPublicationSettled: () => true,
      sealAndPublishExit: () => false,
      publish: () => false,
      onCreditAvailable: () => {},
      receivingActivation: () => undefined,
      waitForPendingSend: async () => true,
      activate: (id: string) => {
        if (!closeId) {
          closeId = id
          queueMicrotask(() => {
            closing = close(id)
            void closing.catch(() => {})
          })
        }
        return false
      },
      getDebugSnapshot: () => ({}),
      dispose: () => {}
    } as unknown as RelayPtySourcePublication)
    await expect(spawn({ agentSessionEnsure: ensure })).rejects.toThrow('terminating')
    expect(handler.activePtyCount).toBe(1)
    const firstExit = exit
    const retried = spawn({ agentSessionEnsure: ensure })
    const outcome = await retried.then(
      () => 'created',
      () => 'rejected'
    )
    const spawnCount = mockPtySpawn.mock.calls.length
    release?.()
    firstExit?.({ exitCode: 137 })
    await closing
    expect(outcome).toBe('rejected')
    expect(spawnCount).toBe(1)
  })
})
