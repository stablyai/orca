import { afterEach, describe, expect, it } from 'vitest'
import {
  assertFederatedWorkerStartAdmitted,
  assertWorkerStartAdmitted
} from '../../rpc/methods/orchestration-worker-route-admission'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcomeIntake } from './outcome-intake'
import type { RuntimeBuildIdentity } from './runtime-build-identity'

const BUILD: RuntimeBuildIdentity = {
  version: 'test',
  buildHash: 'a'.repeat(16),
  artifactManifestVerified: true,
  provenanceSource: 'embedded',
  dirtyBuild: false,
  commitSha: 'a'.repeat(40),
  id: 'build_test'
}

const GATE = {
  gateId: 'unit',
  program: 'node',
  args: ['--test'],
  dependencies: ['git:package.json'],
  policyVersion: 'unit-v1',
  commandIdentity: 'node:test:v1',
  shaBinding: 'exact_head' as const
}

function outcome(outcomeId: string, runId: string, fingerprint: string) {
  return {
    outcomeId,
    runId,
    title: outcomeId,
    fingerprint,
    objective: `Deliver ${outcomeId}`,
    target: 'id:repo::/wt',
    dependencies: [] as string[],
    semanticClaims: [outcomeId],
    resourceClaims: ['src/shared.ts'],
    routingPolicy: {
      taskClassification: 'bounded_implementation' as const,
      builderCandidates: [{ agent: 'claude' as const, model: 'opus-5', reasoning: 'high' }],
      reviewerCandidates: [{ agent: 'claude' as const, model: 'fable', reasoning: 'high' }],
      reviewCapabilities: ['adversarial_review' as const],
      allowUnknownQuota: false
    },
    requiredGates: [GATE]
  }
}

/** FEDERATED_START_BYPASSES_THE_FENCES — `orchestration.workerStart --on <host>`
 *  returned before `assertWorkerStartAdmitted` ever ran, so it checked the route
 *  and nothing else. A serialized outcome and a worktree under a live validation
 *  lease were both fenced locally and wide open federated.
 *
 *  Where the work executes does not change whether it is allowed to start.
 */
describe('FEDERATED_START_BYPASSES_THE_FENCES', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  function serializedPair() {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const runs = [1, 2].map(
      (index) =>
        db!.createRun({
          objective: `Outcome ${index}`,
          coordinatorHandle: `term_${index}`,
          coordinatorPaneKey: `pane_${index}:leaf`
        }).id
    )
    expect(
      admitOutcomeIntake(store, {
        batchId: 'batch_1',
        outcomes: [outcome('out_1', runs[0], 'f1'), outcome('out_2', runs[1], 'f2')],
        detected: [{ leftOutcomeId: 'out_1', rightOutcomeId: 'out_2', kind: 'resource_collision' }],
        relations: [
          {
            leftOutcomeId: 'out_1',
            rightOutcomeId: 'out_2',
            kind: 'resource_collision',
            decision: 'serialize',
            rationale: 'Both write the same ledger.'
          }
        ]
      }).ok
    ).toBe(true)
    // Outcome 1 is live, so outcome 2 must not start work by any route.
    const task = db.createTask({ spec: 'work', runId: runs[0] })
    db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'codex', resolvedWorktreeId: 'repo::/wt' }
    })
    return { runs }
  }

  it('refuses a federated start before effects because its immutable remote target is unverified', () => {
    const { runs } = serializedPair()
    expect(() =>
      assertFederatedWorkerStartAdmitted({
        handle: db!,
        runtimeBuildIdentity: BUILD,
        runId: runs[1],
        agent: 'codex'
      })
    ).toThrow(/cannot start federated/)
  })

  it('keeps the federated target boundary fail-closed after serialization releases', () => {
    const { runs } = serializedPair()
    db!.db.prepare(`UPDATE dispatch_contexts SET status = 'completed'`).run()
    expect(() =>
      assertFederatedWorkerStartAdmitted({
        handle: db!,
        runtimeBuildIdentity: BUILD,
        runId: runs[1],
        agent: 'codex'
      })
    ).toThrow(/cannot start federated/)
  })

  it('fences local serialization and federated target authority before either can launch', () => {
    const { runs } = serializedPair()
    const task = db!.createTask({ spec: 'work', runId: runs[1] })
    expect(() =>
      assertWorkerStartAdmitted({
        handle: db!,
        runtimeBuildIdentity: BUILD,
        runId: runs[1],
        taskId: task.id,
        agent: 'codex',
        worktreeId: 'repo::/wt'
      })
    ).toThrow(/serialized against/)
    expect(() =>
      assertFederatedWorkerStartAdmitted({
        handle: db!,
        runtimeBuildIdentity: BUILD,
        runId: runs[1],
        agent: 'codex'
      })
    ).toThrow(/cannot start federated/)
  })
})
