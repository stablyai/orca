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

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('legacy takeover by current runtime authority', () => {
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
        run: {
          id: harness.adoptedRunId,
          coordinator_handle: CURRENT_COORDINATOR_HANDLE,
          coordinator_pane_key: CURRENT_COORDINATOR_PANE
        }
      }
    })
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
