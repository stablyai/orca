import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'

const DISPATCH = 'ctx_recovered'
const PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PTY = 'ssh:relay:pty-worker'
const INCARNATION = 'inc:worker'
const STALE = 'term_expired'
const HOST = JSON.stringify({ kind: 'local', hostId: 'local' })

describe('federation incarnation recovery', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(PTY, 'folder-workspace', null, {
      tabId: 'tab_worker',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      incarnationId: INCARNATION
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({ ptyKilled: true } as never)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      entries: [{ cursor: 1, text: 'durable worker output' }],
      nextCursor: 1,
      tail: ['durable worker output'],
      truncated: false
    } as never)
  })

  afterEach(() => db.close())

  function attach(hostScope: string | null = HOST) {
    db.createRemoteDispatchAttachment({
      dispatchId: DISPATCH,
      taskId: 'task_worker',
      homePeerFingerprint: 'home',
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home',
        requestId: 'attach',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH,
      paneKey: PANE,
      processIncarnation: `${PTY}:${INCARNATION}`,
      worktreeId: 'folder-workspace',
      terminalHandle: STALE,
      setupState: 'not_applicable',
      effects: [],
      hostScope,
      terminalOwnership: 'created'
    })
    db.markRemoteAttachmentReady(DISPATCH)
  }

  function settle() {
    db.recordRemoteAttachmentStage({
      dispatchId: DISPATCH,
      state: 'succeeded',
      stage: 'worker_reported'
    })
  }

  function call(name: string) {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === `orchestration.${name}`
    )!
    return method.handler(method.params!.parse({ dispatchId: DISPATCH }), {
      runtime,
      authenticatedCallerFingerprint: 'home'
    } as never)
  }

  it('reads and stops the same live incarnation through a newly resolved handle', async () => {
    attach()
    await expect(runtime.showTerminal(STALE)).rejects.toThrow()
    const current = runtime.resolveTerminalHandleByProcessIncarnation(
      `${PTY}:${INCARNATION}`,
      HOST
    )!
    expect(current).not.toBe(STALE)
    await expect(call('federationShow')).resolves.toMatchObject({
      observation: { exactWorker: true, status: 'live' }
    })
    await call('federationRead')
    expect(runtime.readTerminal).toHaveBeenCalledWith(current, {
      cursor: undefined,
      limit: undefined
    })
    await expect(call('federationStop')).resolves.toMatchObject({ state: 'stopped' })
    expect(runtime.closeTerminal).toHaveBeenCalledWith(current)
  })

  it('archives before releasing the recovered terminal, retaining the durable lease identity', async () => {
    attach()
    settle()
    const current = runtime.resolveTerminalHandleByProcessIncarnation(
      `${PTY}:${INCARNATION}`,
      HOST
    )!
    vi.mocked(runtime.closeTerminal).mockImplementation(async (handle) => {
      expect(db.getWorkerTerminalArchive(DISPATCH)).toBeDefined()
      expect(handle).toBe(current)
      return { ptyKilled: true } as never
    })
    await expect(call('federationRelease')).resolves.toMatchObject({ state: 'released' })
    expect(db.getWorkerTerminalResourceByOwner(DISPATCH)).toMatchObject({
      terminal_handle: STALE,
      release_state: 'released'
    })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    await expect(call('federationRelease')).resolves.toMatchObject({ state: 'already_released' })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it.each([
    null,
    JSON.stringify({ kind: 'ssh', targetId: 'other-host' }),
    JSON.stringify({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' })
  ])('retains close intent when the host scope cannot match: %s', async (scope) => {
    attach(scope)
    settle()
    await expect(call('federationRelease')).resolves.toMatchObject({ state: 'release_pending' })
    expect(db.getWorkerTerminalResourceByOwner(DISPATCH)?.release_state).toBe('requested')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('does not recover a recycled PTY incarnation', async () => {
    attach()
    runtime.registerPty(PTY, 'folder-workspace', null, {
      tabId: 'tab_worker',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      incarnationId: 'replacement'
    })
    await expect(call('federationStop')).resolves.toMatchObject({
      state: 'stop_unknown',
      processAction: 'none'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('retains user ownership even when the terminal can be recovered', async () => {
    attach()
    settle()
    db.markWorkerTerminalUserOwned(PANE)
    await expect(call('federationRelease')).resolves.toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it.each(['live', 'unverifiable', 'exited'] as const)(
    'recovers lost close acknowledgement after restart only for host verdict %s',
    async (verdict) => {
      attach()
      settle()
      vi.mocked(runtime.closeTerminal).mockRejectedValueOnce(new Error('endpoint is not connected'))
      await expect(call('federationRelease')).resolves.toMatchObject({ state: 'release_pending' })
      expect(db.getWorkerTerminalArchive(DISPATCH)).toBeDefined()
      runtime = new OrcaRuntimeService(null)
      runtime.setOrchestrationDb(db)
      const inspect = vi
        .spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness')
        .mockResolvedValue(verdict)
      const close = vi.spyOn(runtime, 'closeTerminal')
      await expect(call('federationRelease')).resolves.toMatchObject({
        state: verdict === 'exited' ? 'released' : 'release_pending'
      })
      expect(inspect).toHaveBeenCalledWith(`${PTY}:${INCARNATION}`, HOST)
      expect(close).not.toHaveBeenCalled()
    }
  )

  it('refuses release if the process changes while its output is archived', async () => {
    attach()
    settle()
    vi.mocked(runtime.readTerminal).mockImplementation(async () => {
      runtime.registerPty(PTY, 'folder-workspace', null, {
        tabId: 'tab_worker',
        leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        incarnationId: 'replacement'
      })
      return { tail: ['last output'], entries: [], truncated: false } as never
    })
    await expect(call('federationRelease')).resolves.toMatchObject({ state: 'retained' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('does not settle a failed kill and retries the same incarnation', async () => {
    attach()
    settle()
    vi.mocked(runtime.closeTerminal).mockResolvedValueOnce({
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable'
    } as never)
    await expect(call('federationRelease')).resolves.toMatchObject({ state: 'release_unknown' })
    expect(db.getWorkerTerminalResourceByOwner(DISPATCH)?.release_state).toBe('unknown')
    await expect(call('federationRelease')).resolves.toMatchObject({ state: 'released' })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(2)
  })
})
