import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { prepareLocalWorkerStart } from './worker-start-validation'
import type { WorkerStartInput } from './worker-start-schema'

// I1: resolveWorkerLaunchPreferences must skip the local Claude probe (never claim `source:
// 'probe'`) when the worker's placement is remote or the agent has a launch command override
// the probe never saw. These test the threading from worker-start-validation.ts through to that
// scoping, not resolveWorkerLaunchPreferences's own logic (covered directly in
// worker-launch-preferences.test.ts).
function makeRuntime(agentCmdOverrides: Record<string, string> = {}): OrcaRuntimeService {
  return {
    validateOrchestrationAgentLauncher: () => {},
    getClientSettings: () => ({ agentCmdOverrides })
  } as unknown as OrcaRuntimeService
}

function baseParams(overrides: Partial<WorkerStartInput> = {}): WorkerStartInput {
  return {
    from: 'term_coord',
    spec: 'do work',
    agent: 'claude',
    model: 'aws-bedrock-opus-5',
    ...overrides
  } as WorkerStartInput
}

describe('prepareLocalWorkerStart launch receipt placement scoping (I1)', () => {
  it('marks the receipt unverified, never probing, for a remote --on placement', async () => {
    const result = await prepareLocalWorkerStart({
      params: baseParams({ on: 'ssh-host-1' }),
      createsWorktree: false,
      runtime: makeRuntime()
    })

    // Why this proves the probe was skipped, not just relabeled: a real spawn of `claude` would
    // either fail in CI (binary absent) or hang past the test timeout -- resolving at all with
    // this shape means resolveWorkerLaunchPreferences never called probeClaudeModelsOnce.
    expect(result.launch.receipt).toEqual({
      requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: null },
      effective: null,
      source: 'unverified',
      unverifiedReason: expect.stringContaining('remote')
    })
  })

  it('marks the receipt unverified, never probing, when the agent has a command override', async () => {
    const result = await prepareLocalWorkerStart({
      params: baseParams(),
      createsWorktree: false,
      runtime: makeRuntime({ claude: 'my-claude-wrapper' })
    })

    expect(result.launch.receipt).toEqual({
      requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: null },
      effective: null,
      source: 'unverified',
      unverifiedReason: expect.stringContaining('custom launch command')
    })
  })

  it('leaves the no-agent (--terminal reuse) receipt labeled catalog, not a bare clone', async () => {
    const result = await prepareLocalWorkerStart({
      params: baseParams({ agent: undefined, model: undefined, terminal: 'term_existing' }),
      createsWorktree: false,
      runtime: makeRuntime()
    })

    expect(result.launch.receipt).toEqual({
      requested: { agent: null, model: null, effort: null },
      effective: { agent: null, model: null, effort: null },
      source: 'catalog'
    })
  })
})
