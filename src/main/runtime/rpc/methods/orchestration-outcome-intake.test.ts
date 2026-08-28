import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_OUTCOME_INTAKE_METHODS } from './orchestration-outcome-intake'

const COORDINATOR = 'term_coord'
const COORDINATOR_PANE = 'tab_coord:leaf_coord'
const WORKTREE_ID = 'repo_test::worktree_test'
const GATE = {
  gateId: 'unit',
  program: 'node',
  args: ['--test'],
  dependencies: ['git:package.json'],
  policyVersion: 'unit-v1',
  commandIdentity: 'node:test:v1',
  shaBinding: 'exact_head' as const
}

/** Registered-RPC proof over a real managed Git worktree and committed gate catalog. */
describe('BATCH_2_TO_5_INTAKE', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined
  let repoPath: string | undefined
  const runIdsByIndex = new Map<number, string>()

  afterEach(() => {
    db?.close()
    db = undefined
    runtime = undefined
    runIdsByIndex.clear()
    if (repoPath) {
      rmSync(repoPath, { recursive: true, force: true })
    }
    repoPath = undefined
    vi.restoreAllMocks()
  })

  const METHOD = ORCHESTRATION_OUTCOME_INTAKE_METHODS.find(
    (method) => method.name === 'orchestration.outcomeIntake'
  )

  function ensureRuntime(): OrcaRuntimeService {
    if (runtime) {
      return runtime
    }
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    repoPath = mkdtempSync(join(tmpdir(), 'orca-intake-repo-'))
    mkdirSync(join(repoPath, '.orca'), { recursive: true })
    writeFileSync(join(repoPath, 'package.json'), '{"name":"intake-fixture"}\n')
    writeFileSync(
      join(repoPath, '.orca/control-plane-gates.json'),
      `${JSON.stringify({ schemaVersion: 1, gates: [GATE] }, null, 2)}\n`
    )
    execFileSync('git', ['init', '-q'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.email', 'test@orca.local'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.name', 'Orca Test'], { cwd: repoPath })
    execFileSync('git', ['add', 'package.json', '.orca/control-plane-gates.json'], {
      cwd: repoPath
    })
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoPath })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === COORDINATOR ? COORDINATOR_PANE : null
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: WORKTREE_ID,
      path: repoPath
    } as never)
    return runtime
  }

  async function call(input: Record<string, unknown>) {
    const currentRuntime = ensureRuntime()
    const params = METHOD!.params!.parse({ from: COORDINATOR, ...input })
    return METHOD!.handler(params, {
      runtime: currentRuntime,
      orchestrationCompatibilityCallerAuthority: {
        hostScope: { kind: 'local', hostId: 'local' },
        terminalHandle: COORDINATOR,
        paneKey: COORDINATOR_PANE,
        processIncarnation: 'pty_coord:1',
        launchTokenHash: 'coord_hash'
      }
    } as never)
  }

  function outcome(index: number) {
    ensureRuntime()
    let runId = runIdsByIndex.get(index)
    if (!runId) {
      runId = db!.createRun({
        objective: `Outcome ${index}`,
        coordinatorHandle: COORDINATOR,
        coordinatorPaneKey: COORDINATOR_PANE
      }).id
      runIdsByIndex.set(index, runId)
    }
    return {
      outcomeId: `out_${index}`,
      runId,
      title: `Outcome ${index}`,
      fingerprint: `f_${index}`,
      objective: `Deliver outcome ${index}`,
      target: `id:${WORKTREE_ID}`,
      dependencies: [] as string[],
      semanticClaims: [`semantic_${index}`],
      resourceClaims: [`src/outcome-${index}.ts`],
      routingPolicy: {
        taskClassification: 'bounded_implementation',
        builderCandidates: [{ agent: 'claude', model: 'opus-5', reasoning: 'high' }],
        reviewerCandidates: [{ agent: 'claude', model: 'fable', reasoning: 'high' }],
        reviewCapabilities: ['adversarial_review'],
        allowUnknownQuota: false
      },
      requiredGates: [GATE]
    }
  }

  it('is a real registered RPC operation', () => expect(METHOD).toBeDefined())

  it('binds three independent outcomes atomically, including routing policy', async () => {
    const receipt = (await call({
      batchId: 'batch_1',
      outcomes: [outcome(1), outcome(2), outcome(3)]
    })) as { batchId: string; count: number; admitted: { outcomeId: string; runId: string }[] }
    expect(receipt).toMatchObject({ batchId: 'batch_1', count: 3 })
    expect(new Set(receipt.admitted.map((entry) => entry.runId)).size).toBe(3)
    expect(
      db!.db
        .prepare(
          'SELECT reviewer_candidates FROM control_plane_outcome_policy WHERE outcome_id = ?'
        )
        .get('out_1')
    ).toEqual({
      reviewer_candidates: JSON.stringify([{ agent: 'claude', model: 'fable', reasoning: 'high' }])
    })
  })

  it('never partially admits a conflicting batch', async () => {
    await call({ batchId: 'batch_1', outcomes: [outcome(1), outcome(2)] })
    await expect(
      call({
        batchId: 'batch_2',
        outcomes: [outcome(9), { ...outcome(1), runId: outcome(5).runId }]
      })
    ).rejects.toMatchObject({ code: 'outcome_intake_rejected' })
    expect(new ControlPlaneStore(db!).getOutcomeById('out_9')).toBeUndefined()
  })

  it('is replay-idempotent and rejects a changed same-key manifest', async () => {
    const request = { batchId: 'batch_1', outcomes: [outcome(1), outcome(2)] }
    await call(request)
    await call(request)
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcomes').get()).toEqual({
      n: 2
    })
    await expect(
      call({ batchId: 'batch_1', outcomes: [outcome(1), { ...outcome(2), objective: 'changed' }] })
    ).rejects.toMatchObject({ code: 'outcome_intake_rejected' })
  })

  it('refuses undecided overlap and persists an explicit serialization decision', async () => {
    const detected = [
      { leftOutcomeId: 'out_1', rightOutcomeId: 'out_2', kind: 'resource_collision' as const }
    ]
    await expect(
      call({ batchId: 'batch_1', outcomes: [outcome(1), outcome(2)], detected })
    ).rejects.toMatchObject({ code: 'outcome_intake_rejected' })
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcomes').get()).toEqual({
      n: 0
    })

    const receipt = (await call({
      batchId: 'batch_2',
      outcomes: [outcome(1), outcome(2)],
      detected,
      relations: [
        { ...detected[0], decision: 'serialize', rationale: 'Both touch the same worktree.' }
      ]
    })) as { relations: { decision: string }[] }
    expect(receipt.relations[0].decision).toBe('serialize')
  })

  it('rejects reject/merge decisions and a batch outside the 2-5 band without effects', async () => {
    for (const decision of ['reject', 'merge'] as const) {
      await expect(
        call({
          batchId: `batch_${decision}`,
          outcomes: [outcome(1), outcome(2)],
          relations: [
            {
              leftOutcomeId: 'out_1',
              rightOutcomeId: 'out_2',
              kind: 'semantic_overlap',
              decision,
              rationale: 'One canonical outcome is required.'
            }
          ]
        })
      ).rejects.toMatchObject({ code: 'outcome_intake_rejected' })
    }
    await expect(call({ batchId: 'small', outcomes: [outcome(1)] })).rejects.toMatchObject({
      code: 'outcome_intake_rejected'
    })
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcomes').get()).toEqual({
      n: 0
    })
  })

  it('rejects a foreign coordinator before writing anything', async () => {
    const foreign = outcome(1)
    const run = db!.createRun({
      objective: 'Foreign',
      coordinatorHandle: 'term_foreign',
      coordinatorPaneKey: 'tab_foreign:leaf'
    })
    await expect(
      call({ batchId: 'foreign', outcomes: [{ ...foreign, runId: run.id }, outcome(2)] })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcomes').get()).toEqual({
      n: 0
    })
  })
})
