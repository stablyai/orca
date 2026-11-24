import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from '../testing/pipeline-worker-release.test-fixture'
import * as placement from '../../rpc/methods/orchestration/worker/start/placement/worker-start-agent-placement'
import { getWorkerTerminalAutoReleaseScheduler } from '../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2WorkerPorts } from './pipeline-v2-worker-adapter'
import {
  gatedV2Template,
  pipelineV2AdmissionFixture,
  fixtureSource,
  v2Mutation
} from './pipeline-v2.test-fixture'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { PipelineV2Admission } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'

const h = createOrchestrationWorkerReleaseHarness()
afterEach(() => {
  getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
  h.cleanup()
})
it.each([
  {
    agent: 'codex',
    effort: 'deep-chat',
    permission: 'own',
    expected: { model: 'fixture-model-a', effort: 'deep-chat', mode: 'own' }
  },
  {
    agent: 'opencode',
    effort: undefined,
    permission: 'ask',
    expected: { model: 'fixture-model-a', mode: 'ask' }
  }
] as const)(
  'carries $agent chat preferences to native placement without terminal defaults',
  async ({ agent, effort, permission, expected }) => {
    h.setup()
    vi.spyOn(h.runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    let placed: AgentLaunchPreferences | undefined
    vi.spyOn(placement, 'placeWorkerAgent').mockImplementation(async (request) => {
      placed = request.launch.preferences
      throw new Error('Native host refused before creating a session')
    })
    const store = new PipelineStore(':memory:')
    try {
      const template = gatedV2Template()
      const authored = template.stages[0]
      if (authored.kind !== 'agent') {
        throw new Error('Expected agent stage')
      }
      authored.executor.agent = agent
      const admission = PipelineV2Admission.parse(pipelineV2AdmissionFixture(template))
      admission.workspace.id = 'repo::worktree'
      admission.effectiveExecutors.plan.agent = agent
      admission.effectiveExecutors.plan.effort = effort
      admission.effectiveExecutors.plan.permissionMode = permission
      const run = store.createV2(admission)
      const reserved = v2Mutation(store, {
        kind: 'reserve',
        invocationId: 'chat-stage',
        purpose: 'stage',
        sourceRevision: fixtureSource
      })
      const stage = run.definition.stages[0]
      if (stage.kind !== 'agent') {
        throw new Error('Expected agent stage')
      }
      const result = await pipelineV2WorkerPorts(h.runtime).startInvocation(
        {
          runId: run.id,
          workspace: run.workspace,
          invocation: reserved.invocations[0],
          executor: run.effectiveExecutors.plan,
          stage
        },
        'Read stage context',
        () => {}
      )
      expect(result.state).toBe('outcome_unknown')
      expect(placed).toEqual(expected)
    } finally {
      store.close()
    }
  }
)
