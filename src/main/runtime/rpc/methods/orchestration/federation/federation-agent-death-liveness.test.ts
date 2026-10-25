import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods } from '../../../core'
import { orchestrationTimestampToMs } from '../worker/worker-output'
import { prepareFederatedAttachmentAuthority } from './federation-attachment-authority'

// #24353: the execution host must report `exited` once it can prove the worker's agent is gone —
// killed inside a PTY that survives it, or taken down with the PTY by a reboot.

const HOME_FINGERPRINT = 'home-peer-fingerprint'
const DISPATCH_ID = 'ctx_federation_agent_death'
const HANDLE = 'term_remote_worker'
const PANE_KEY = 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INCARNATION = 'pty-remote:incarnation-1'

describe('federation host agent-death liveness', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(PANE_KEY)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(INCARNATION)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observation reads only these fields.
      {
        handle: HANDLE,
        worktreeId: 'repo::remote-worktree',
        connected: true,
        status: 'running'
      } as never
    )
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: ['pty-remote']
    })
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: DISPATCH_ID,
      taskId: 'task_remote',
      homePeerFingerprint: HOME_FINGERPRINT,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: HOME_FINGERPRINT,
        requestId: 'rpc_attach',
        method: 'orchestration.federationStart',
        payloadHash: 'hash'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH_ID,
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      worktreeId: 'repo::remote-worktree',
      terminalHandle: HANDLE,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: HANDLE }],
      hostScope: JSON.stringify({ kind: 'local' }),
      terminalOwnership: 'created'
    })
    db.markRemoteAttachmentReady(DISPATCH_ID)
  })

  afterEach(() => db.close())

  async function call(name: string) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === name
    )
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const params =
      name === 'orchestration.federationFleetSnapshot'
        ? { dispatchIds: [DISPATCH_ID] }
        : { dispatchId: DISPATCH_ID }
    return method.handler(method.params!.parse(params), {
      runtime,
      authenticatedCallerFingerprint: HOME_FINGERPRINT
    })
  }

  async function snapshotObservation() {
    const snapshot = await call('orchestration.federationFleetSnapshot')
    return snapshot &&
      typeof snapshot === 'object' &&
      'items' in snapshot &&
      Array.isArray(snapshot.items)
      ? snapshot.items[0]?.observation
      : undefined
  }

  it('reports exited when the agent in a still-live PTY is proven dead', async () => {
    const presence = vi.spyOn(runtime, 'checkTerminalAgentPresence').mockResolvedValue('exited')
    await expect(snapshotObservation()).resolves.toEqual({ status: 'exited', exactWorker: true })
    await expect(call('orchestration.federationShow')).resolves.toMatchObject({
      observation: { status: 'exited', exactWorker: true }
    })
    // Fenced to exits proven since the attachment, so an earlier agent's exit cannot count.
    const attachedAt = db.getRemoteDispatchAttachment(DISPATCH_ID)!.created_at
    // Not rounded up: attach forgets earlier exits, so an exit in the creation second is the worker's.
    expect(presence).toHaveBeenCalledWith(HANDLE, orchestrationTimestampToMs(attachedAt))
  })

  it('keeps the PTY verdict when no hook identified the agent or it cannot be checked', async () => {
    vi.spyOn(runtime, 'checkTerminalAgentPresence')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('unverifiable')
    await expect(snapshotObservation()).resolves.toEqual({ status: 'live', exactWorker: true })
    await expect(snapshotObservation()).resolves.toEqual({ status: 'live', exactWorker: true })
  })

  it('reports exited after a reboot when the host process table lacks the PTY', async () => {
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const inspect = vi
      .spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness')
      .mockResolvedValue('exited')
    await expect(snapshotObservation()).resolves.toEqual({ status: 'exited', exactWorker: true })
    expect(inspect).toHaveBeenCalledWith(INCARNATION, JSON.stringify({ kind: 'local' }))
  })

  it('never certifies a legacy runtime-scoped incarnation as exited', async () => {
    const legacy = `${runtime.getRuntimeId()}:pty-legacy:1`
    db.db
      .prepare(
        'UPDATE remote_dispatch_attachments SET process_incarnation = ? WHERE dispatch_id = ?'
      )
      .run(legacy, DISPATCH_ID)
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const inspect = vi
      .spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness')
      .mockResolvedValue('exited')
    await expect(snapshotObservation()).resolves.toEqual({
      status: 'unverifiable',
      exactWorker: false
    })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('forgets the pane agent exit the hook store held before this worker attached', () => {
    const forget = vi.spyOn(runtime, 'forgetTerminalAgentExit').mockImplementation(() => {})
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
    vi.mocked(runtime.getTerminalPaneKey).mockReturnValue(
      'tab_reused:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: 'ctx_reused_pane',
      taskId: 'task_reused',
      homePeerFingerprint: HOME_FINGERPRINT,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: HOME_FINGERPRINT,
        requestId: 'rpc_attach_reused',
        method: 'orchestration.federationStart',
        payloadHash: 'hash-reused'
      }
    })
    prepareFederatedAttachmentAuthority({
      runtime,
      db,
      dispatchId: 'ctx_reused_pane',
      terminalHandle: 'term_reused',
      worktreeId: 'repo::remote-worktree',
      setup: {
        requested: 'not_applicable',
        effective: 'not_applicable',
        source: 'test',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_applicable'
      },
      effects: [],
      reusesTerminal: true
    })
    expect(forget).toHaveBeenCalledWith('term_reused')
  })

  it('stays unverifiable after a reboot when the process table cannot be read', async () => {
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('unverifiable')
    await expect(snapshotObservation()).resolves.toEqual({
      status: 'unverifiable',
      exactWorker: false
    })
  })
})
