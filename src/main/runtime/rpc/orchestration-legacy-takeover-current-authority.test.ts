import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  request
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'
import { ORCHESTRATION_METHODS } from './methods/orchestration'

const PTY_ID = 'pty-current-launch'

class CurrentLaunchRuntime extends OrcaRuntimeService {
  bindLaunch(token: string, incarnation = 'current-launch-1'): void {
    const [tabId, leafId] = CURRENT_COORDINATOR_PANE.split(':')
    this.registerPty(PTY_ID, 'repo::/worktree', null, {
      tabId,
      leafId,
      incarnationId: incarnation,
      agentLaunchAuthority: { launchToken: token, launchAgent: 'omp' }
    })
    this.adoptControllerTerminalHandle(PTY_ID, CURRENT_COORDINATOR_HANDLE, incarnation)
  }

  endLaunch(): void {
    this.retirePtyAgentLaunchAuthority(PTY_ID)
  }
}
afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('legacy takeover by current runtime authority', () => {
  it.each([
    ['bytes', 'sleep'],
    ['daemon', null],
    ['bytes', 'failed']
  ] as const)(
    'requires hook authority after a %s marker with a %s foreground read',
    async (path, foregroundResult) => {
      const harness = createHarness()
      const hookServer = new AgentHookServer()
      let resolveForeground: ((process: string | null) => void) | undefined
      let rejectForeground: ((error: Error) => void) | undefined
      const foreground = new Promise<string | null>((resolve, reject) => {
        resolveForeground = resolve
        rejectForeground = reject
      })
      const runtime = new CurrentLaunchRuntime(null, undefined, {
        getAgentProviderSessionRowsForPane: (paneKey) =>
          hookServer.getStatusSnapshotForPane(paneKey),
        retireAgentHookCompatibilityAuthority: (paneKey) => hookServer.retirePaneAuthority(paneKey),
        attestAgentHookCompatibilityAuthority: (candidate) =>
          hookServer.attestCompatibilityAuthority(candidate)
      })
      runtime.setOrchestrationDb(harness.db)
      runtime.setPtyController({
        spawn: async () => ({ id: PTY_ID }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: () => foreground
      })
      const proof = currentEvidence('coordinator')
      runtime.bindLaunch(proof.launchToken!)
      hookServer.ingestRemote(
        {
          paneKey: CURRENT_COORDINATOR_PANE,
          payload: { state: 'done', agentType: 'omp' }
        },
        null
      )
      if (path === 'bytes') {
        runtime.onPtyData(PTY_ID, '\x1b]133;D;0\x07', Date.now())
      } else {
        runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })
      }
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      const params = {
        id: harness.adoptedRunId,
        from: CURRENT_COORDINATOR_HANDLE,
        takeoverLegacy: true
      }
      const before = harness.db.getRun(harness.adoptedRunId)
      const rejected = await dispatcher.dispatch(
        request('orchestration.runUse', params, proof, 'marker-pending')
      )
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: 'legacy_read_only', data: { effectsApplied: false } }
      })
      expect(harness.db.getRun(harness.adoptedRunId)).toEqual(before)
      if (foregroundResult === 'failed') {
        rejectForeground?.(new Error('execution host unavailable'))
      } else {
        resolveForeground?.(foregroundResult)
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      const rejectedAfterRead = await dispatcher.dispatch(
        request('orchestration.runUse', params, proof, 'marker-non-shell')
      )
      expect(rejectedAfterRead).toMatchObject({
        ok: false,
        error: { code: 'legacy_read_only', data: { effectsApplied: false } }
      })
      expect(harness.db.getRun(harness.adoptedRunId)).toEqual(before)
      expect(hookServer.getStatusSnapshotForPane(CURRENT_COORDINATOR_PANE)[0]?.state).toBe('done')
      expect(
        runtime.getOrchestrationDispatchAuthority(CURRENT_COORDINATOR_HANDLE)?.launchTokenHash
      ).toBe(createHash('sha256').update(proof.launchToken!).digest('hex'))
      runtime.bindLaunch(proof.launchToken!)
      expect(
        runtime.verifyOrchestrationCompatibilityCaller(proof, {
          currentRuntimeLaunchSufficient: true
        })
      ).toBeNull()
      hookServer.ingestRemote(
        {
          paneKey: CURRENT_COORDINATOR_PANE,
          launchToken: proof.launchToken,
          payload: { state: 'working', agentType: 'omp' }
        },
        null
      )
      const accepted = await dispatcher.dispatch(
        request('orchestration.runUse', params, proof, 'marker-with-hook')
      )
      expect(accepted).toMatchObject({
        ok: true,
        result: {
          run: { id: harness.adoptedRunId, coordinator_handle: CURRENT_COORDINATOR_HANDLE }
        }
      })
      runtime.endLaunch()
      runtime.bindLaunch('fresh-launch-token')
      const freshProof = { ...proof, launchToken: 'fresh-launch-token' }
      expect(runtime.verifyOrchestrationCompatibilityCaller(freshProof)).toBeNull()
      expect(
        runtime.verifyOrchestrationCompatibilityCaller(freshProof, {
          currentRuntimeLaunchSufficient: true
        })
      ).toMatchObject({
        terminalHandle: CURRENT_COORDINATOR_HANDLE,
        paneKey: CURRENT_COORDINATOR_PANE
      })
    }
  )

  it('accepts a fresh current agent before its first hook observation', async () => {
    const harness = createHarness()
    const hookServer = new AgentHookServer()
    const runtime = new OrcaRuntimeService(null, undefined, {
      attestAgentHookCompatibilityAuthority: (candidate) =>
        hookServer.attestCompatibilityAuthority(candidate)
    })
    const proof = currentEvidence('coordinator')
    const launchTokenHash = createHash('sha256').update(proof.launchToken!).digest('hex')
    runtime.setOrchestrationDb(harness.db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(CURRENT_COORDINATOR_PANE)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      runtimeId: 'runtime-current',
      terminalHandle: CURRENT_COORDINATOR_HANDLE,
      ptyId: 'pty-current',
      worktreeId: 'repo::/worktree',
      processIncarnation: 'process-current',
      paneKey: CURRENT_COORDINATOR_PANE,
      launchTokenHash,
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    // Legacy compatibility mutations still require a hook observation.
    expect(runtime.verifyOrchestrationCompatibilityCaller(proof)).toBeNull()
    for (const [invocationId, forgedProof] of [
      ['forged-token', { ...proof, launchToken: 'forged-token' }],
      ['forged-pane', { ...proof, paneKey: 'tab_forged:66666666-6666-4666-8666-666666666666' }]
    ] as const) {
      const rejected = await dispatcher.dispatch(
        request(
          'orchestration.runUse',
          {
            id: harness.adoptedRunId,
            from: CURRENT_COORDINATOR_HANDLE,
            takeoverLegacy: true
          },
          forgedProof,
          invocationId
        )
      )
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: 'legacy_read_only', data: { effectsApplied: false } }
      })
    }

    const response = await dispatcher.dispatch(
      request(
        'orchestration.runUse',
        {
          id: harness.adoptedRunId,
          from: CURRENT_COORDINATOR_HANDLE,
          takeoverLegacy: true
        },
        proof,
        'fresh-current-agent-takeover'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        run: { id: harness.adoptedRunId, coordinator_handle: CURRENT_COORDINATOR_HANDLE }
      }
    })
    expect(harness.db.getRun(harness.adoptedRunId)?.coordinator_pane_key).toBe(
      CURRENT_COORDINATOR_PANE
    )
  })

  it('requires a runtime-issued SSH attachment for fresh launch proof', async () => {
    const harness = createHarness()
    const runtime = new OrcaRuntimeService()
    const proof = currentEvidence('coordinator')
    const launchTokenHash = createHash('sha256').update(proof.launchToken!).digest('hex')
    const host = runtime.registerOrchestrationCompatibilitySshAttachment(
      'saved-target',
      'connection-current'
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      runtimeId: 'runtime-current',
      terminalHandle: CURRENT_COORDINATOR_HANDLE,
      ptyId: 'pty-current',
      worktreeId: 'repo::/worktree',
      processIncarnation: 'process-current',
      paneKey: CURRENT_COORDINATOR_PANE,
      launchTokenHash,
      hostScope: { kind: 'ssh', targetId: 'saved-target' }
    })
    runtime.setOrchestrationDb(harness.db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(CURRENT_COORDINATOR_PANE)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    const params = {
      id: harness.adoptedRunId,
      from: CURRENT_COORDINATOR_HANDLE,
      takeoverLegacy: true
    }
    const rejected = await dispatcher.dispatch(
      request(
        'orchestration.runUse',
        params,
        { ...proof, host: { ...host, attachmentId: 'caller-chosen' } },
        'forged-ssh-attachment'
      )
    )
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'legacy_read_only', data: { effectsApplied: false } }
    })

    const response = await dispatcher.dispatch(
      request('orchestration.runUse', params, { ...proof, host }, 'valid-ssh-attachment')
    )
    expect(response).toMatchObject({ ok: true })
  })
})
