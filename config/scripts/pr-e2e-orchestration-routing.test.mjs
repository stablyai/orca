import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  hasOrchestrationE2eChange,
  ORCHESTRATION_E2E_ROUTE_ID,
  PR_E2E_SOURCE_ROUTES,
  selectAdvisoryPrE2eSpecs,
  selectOrchestrationPrE2eSpecs,
  selectPrE2eSpecs
} from './pr-e2e-source-routing.mjs'

const prWorkflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const e2eWorkflow = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const filterStep = prWorkflow.jobs.code_paths.steps.find((step) => step.id === 'e2e_filter')
const verifyStep = prWorkflow.jobs.verify.steps.find(
  (step) => step.name === 'Require successful checks'
)
const route = PR_E2E_SOURCE_ROUTES.find((candidate) => candidate.id === ORCHESTRATION_E2E_ROUTE_ID)

/** One product-source file per prefix the route claims authority over. */
const ROUTED_SOURCES = [
  'src/main/runtime/orchestration/db/messages/message-insert.ts',
  'src/main/runtime/orchestration-fleet-agent-status-snapshot.ts',
  'src/main/runtime/rpc/methods/orchestration/messaging/send.ts',
  'src/main/runtime/rpc/orchestration-legacy-mail.ts',
  'src/cli/handlers/orchestration.ts',
  'src/cli/handlers/orchestration/send.ts',
  'src/cli/handlers/orchestration-worker-settlement.ts',
  'src/cli/specs/orchestration.ts',
  'src/cli/specs/orchestration-worker-specs.ts',
  'src/shared/orchestration-check-output.ts',
  'skill-guides/orchestration.md',
  'skill-guides/orchestration/references/worker-contract.md'
]

// The full `git show 98fdbc4adee --name-only` of PR #19542, the change that shipped
// "Run is required" on `orca orchestration send` between two plain terminals. Frozen on
// purpose: the whole point of the case is that this exact diff selected zero specs.
const PR_19542_CHANGED_FILES = [
  'config/reliability-gates.jsonc',
  'config/scripts/orchestration-skill-guidance.test.mjs',
  'skill-guides/orchestration.md',
  'src/cli/bundled-skill-guides.ts',
  'src/main/runtime/orca-runtime-subscribe-to-terminal-resize.ts',
  'src/main/runtime/orca-runtime-tests/lineage-and-scan-cache-part-05.spec.ts',
  'src/main/runtime/orca-runtime-tests/mobile-creation-and-orchestration-part-02.spec.ts',
  'src/main/runtime/orca-runtime-tests/terminal-output-and-worker-recovery-part-04.spec.ts',
  'src/main/runtime/orchestration-messages-fake-parity.test.ts',
  'src/main/runtime/orchestration/coordinator-decision-gates.test.ts',
  'src/main/runtime/orchestration/coordinator-dispatch-unobserved-prompt.test.ts',
  'src/main/runtime/orchestration/coordinator-drift-probe-coalescing.test.ts',
  'src/main/runtime/orchestration/coordinator-escalation-triage.test.ts',
  'src/main/runtime/orchestration/coordinator-stale-base-flag.test.ts',
  'src/main/runtime/orchestration/coordinator.test.ts',
  'src/main/runtime/orchestration/db-empty-dispatch-shortcircuit.benchmark.test.ts',
  'src/main/runtime/orchestration/db-heartbeat-straggler-guard.test.ts',
  'src/main/runtime/orchestration/db-message-timestamp.test.ts',
  'src/main/runtime/orchestration/db-messages.test.ts',
  'src/main/runtime/orchestration/db-task-create-readiness.test.ts',
  'src/main/runtime/orchestration/db-task-dispatch-invariant.test.ts',
  'src/main/runtime/orchestration/db-task-dispatch-lifecycle-guards.test.ts',
  'src/main/runtime/orchestration/db-task-dispatch-races.test.ts',
  'src/main/runtime/orchestration/db-undelivered-mailboxes.test.ts',
  'src/main/runtime/orchestration/db.test.ts',
  'src/main/runtime/orchestration/db/attempt-outcome-projection.test.ts',
  'src/main/runtime/orchestration/db/contract-constants.ts',
  'src/main/runtime/orchestration/db/decision-gate-lifecycle.test.ts',
  'src/main/runtime/orchestration/db/decision-gates/decision-gate-store.ts',
  'src/main/runtime/orchestration/db/dispatch-depth.test.ts',
  'src/main/runtime/orchestration/db/dispatch-mailbox-consumer-fencing.test.ts',
  'src/main/runtime/orchestration/db/dispatch-row-writer.ts',
  'src/main/runtime/orchestration/db/federation/federated-dispatch-observation-fence.test.ts',
  'src/main/runtime/orchestration/db/federation/remote-dispatch-attachment-create.ts',
  'src/main/runtime/orchestration/db/federation/remote-dispatch-attachment-release.test.ts',
  'src/main/runtime/orchestration/db/lifecycle-transition.test.ts',
  'src/main/runtime/orchestration/db/messages/message-insert.ts',
  'src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts',
  'src/main/runtime/orchestration/db/schema/federated-home-run-migration.test.ts',
  'src/main/runtime/orchestration/db/schema/migrate-v40.ts',
  'src/main/runtime/orchestration/db/schema/migrate.ts',
  'src/main/runtime/orchestration/db/tasks/task-store.ts',
  'src/main/runtime/orchestration/db/writer-run-required.test.ts',
  'src/main/runtime/orchestration/dispatch-failure-idempotency.test.ts',
  'src/main/runtime/orchestration/failed-start-terminal-adoption.test.ts',
  'src/main/runtime/orchestration/federation-acknowledgment-integrity.test.ts',
  'src/main/runtime/orchestration/federation-control-message.ts',
  'src/main/runtime/orchestration/lifecycle-caller-edges.test.ts',
  'src/main/runtime/orchestration/lifecycle-reconciliation.test.ts',
  'src/main/runtime/orchestration/lightweight-run-worker-exit-escalation.test.ts',
  'src/main/runtime/orchestration/mailbox-pointer-eligibility.test.ts',
  'src/main/runtime/orchestration/mailbox-pointer-stage.test.ts',
  'src/main/runtime/orchestration/mailbox-pointer-submit.test.ts',
  'src/main/runtime/orchestration/message-batch-atomicity.test.ts',
  'src/main/runtime/orchestration/nested-worker-depth-migration.test.ts',
  'src/main/runtime/orchestration/orchestration-adopted-run-binding.test.ts',
  'src/main/runtime/orchestration/orchestration-all-start-versions-migration.test.ts',
  'src/main/runtime/orchestration/orchestration-db-retention-pagination.test.ts',
  'src/main/runtime/orchestration/orchestration-federated-legacy-probe.test.ts',
  'src/main/runtime/orchestration/orchestration-legacy-storage-test-fixture.ts',
  'src/main/runtime/orchestration/orchestration-mutation-question-db.test.ts',
  'src/main/runtime/orchestration/orchestration-schema-version-skew.ts',
  'src/main/runtime/orchestration/orchestration-settled-worker-resume-fence-db.test.ts',
  'src/main/runtime/orchestration/orchestration-version-skew-migration.test.ts',
  'src/main/runtime/orchestration/orchestration-worker-dispatch-db.test.ts',
  'src/main/runtime/orchestration/r1-identity-migration.test.ts',
  'src/main/runtime/orchestration/types.ts',
  'src/main/runtime/orchestration/worker-start-unobserved-prompt-settlement.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federated-message-targeting.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federated-release-safety.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federated-worker-start.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation-agent-launch.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation-control-mail.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation-folder-placement.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation-lifecycle-settlement.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation-liveness-verdict.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation-setup.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation-start-prompt-budget.test.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation-start-schema.ts',
  'src/main/runtime/rpc/methods/orchestration/federation/federation.ts',
  'src/main/runtime/rpc/methods/orchestration/messaging/check-worker-federated-attachment.test.ts',
  'src/main/runtime/rpc/methods/orchestration/messaging/check-worker.ts',
  'src/main/runtime/rpc/methods/orchestration/runs/migration-behavior.test.ts',
  'src/main/runtime/rpc/methods/orchestration/worker/failed-start-residual-terminal.test.ts',
  'src/main/runtime/rpc/methods/orchestration/worker/legacy-dispatch-projection.test.ts',
  'src/main/runtime/rpc/methods/orchestration/worker/manual-dispatch-observation.test.ts',
  'src/main/runtime/rpc/methods/structured-worker-stop-receipt.test.ts',
  'src/main/runtime/rpc/orchestration-11745-regression-verification.test.ts',
  'src/main/runtime/rpc/orchestration-legacy-compatibility-dispatcher-test-fixture.ts',
  'src/main/runtime/rpc/orchestration-legacy-coordinator-race.test.ts',
  'src/main/runtime/rpc/orchestration-legacy-question-takeover.test.ts',
  'src/main/runtime/rpc/orchestration-legacy-takeover-delivery.test.ts',
  'src/main/runtime/rpc/orchestration-legacy-takeover-dispatcher.test.ts',
  'src/main/runtime/rpc/orchestration-mutation-ledger.test.ts',
  'src/main/runtime/rpc/orchestration-mutation-request-show.test.ts',
  'src/main/runtime/rpc/orchestration-runtime-update-settlement.test.ts',
  'src/main/runtime/runtime-legacy-worker-terminal-resume-fence.test.ts',
  'src/main/runtime/runtime-rpc-request-authorization.test.ts',
  'src/shared/orchestration-fleet-projection.test.ts',
  'src/shared/orchestration-fleet-worker-projection.ts'
]

describe('orchestration PR E2E routing', () => {
  it('routes every orchestration source prefix at the full spec list', () => {
    for (const source of ROUTED_SOURCES) {
      expect(selectPrE2eSpecs([source]), source).toEqual(route.specs)
    }
  })

  it('leaves orchestration unit tests off the lane they cannot regress', () => {
    // Why: those files are the bulk of an orchestration PR's diff. Routing them would put a
    // 10-spec Playwright gate on every test-only edit, the cost the filter exists to avoid --
    // and #19542 proved the unit layer is not what catches this class anyway.
    for (const source of ROUTED_SOURCES.filter((file) => file.endsWith('.ts'))) {
      expect(selectPrE2eSpecs([source.replace(/\.ts$/, '.test.ts')]), source).toEqual([])
    }
    expect(
      selectOrchestrationPrE2eSpecs(['src/main/runtime/orchestration/rpc-test-harness.ts'])
    ).toEqual([])
    // Named surfaces deliberately NOT made authorities: routing them would run this gate on most
    // PRs. orca-runtime.ts is the honest gap -- see the PR body.
    for (const source of [
      'src/main/runtime/orca-runtime.ts',
      'src/shared/agents-orchestration-steps.ts'
    ]) {
      expect(selectOrchestrationPrE2eSpecs([source]), source).toEqual([])
    }
  })

  it('claims every orchestration and worker spec that exists', () => {
    // Why derived from the directory: a new orchestration spec nobody adds to the route is a
    // spec the blocking gate never runs, which is the #19542 shape again.
    const onDisk = readdirSync('tests/e2e')
      .filter((file) => file.endsWith('.spec.ts') && /orchestration|worker/i.test(file))
      .map((file) => `tests/e2e/${file}`)
      .sort()
    expect(onDisk.length).toBeGreaterThan(0)
    expect([...route.specs].sort()).toEqual(onDisk)
  })

  it('selects the orchestration specs from the #19542 diff that selected none', () => {
    expect(selectOrchestrationPrE2eSpecs(PR_19542_CHANGED_FILES)).toEqual(route.specs)
    expect(hasOrchestrationE2eChange(PR_19542_CHANGED_FILES)).toBe(true)
    // The single file whose deletion caused the user-visible break, on its own.
    expect(
      hasOrchestrationE2eChange(['src/main/runtime/orchestration/db/messages/message-insert.ts'])
    ).toBe(true)
    expect(hasOrchestrationE2eChange(['src/main/git/git-status.ts'])).toBe(false)
  })

  it('runs each selected spec in exactly one of the two lanes', () => {
    // Why partition rather than "advisory minus source-matched": editing an orchestration spec
    // alone selects it with no source match, and keying the split on source would drop it from
    // the advisory list without ever adding it to the blocking one.
    const specEdit = ['tests/e2e/orchestration-idle-mail-delivery.spec.ts']
    expect(selectOrchestrationPrE2eSpecs(specEdit)).toEqual(specEdit)
    expect(selectAdvisoryPrE2eSpecs(specEdit)).toEqual([])
    const mixed = [...specEdit, 'tests/e2e/active-view-restart-restore.spec.ts']
    expect(selectAdvisoryPrE2eSpecs(mixed)).toEqual([
      'tests/e2e/active-view-restart-restore.spec.ts'
    ])
    for (const changed of [PR_19542_CHANGED_FILES, specEdit, mixed]) {
      expect(
        [...selectAdvisoryPrE2eSpecs(changed), ...selectOrchestrationPrE2eSpecs(changed)].sort()
      ).toEqual(selectPrE2eSpecs(changed))
    }
  })

  it('blocks verify on the orchestration lane while the whole suite stays advisory', () => {
    expect(prWorkflow.jobs.verify.needs).toContain('orchestration_e2e')
    expect(prWorkflow.jobs.verify.needs).not.toContain('e2e')
    expect(verifyStep.env.ORCHESTRATION_E2E).toBe('${{ needs.orchestration_e2e.result }}')
    expect(verifyStep.env.ORCHESTRATION_E2E_SHOULD_RUN).toBe(
      '${{ needs.code_paths.outputs.orchestration_e2e }}'
    )
    expect(verifyStep.run).toContain(
      'check_job orchestration_e2e "$ORCHESTRATION_E2E" "$ORCHESTRATION_E2E_SHOULD_RUN"'
    )
  })

  it('feeds the blocking job only the orchestration specs', () => {
    const job = prWorkflow.jobs.orchestration_e2e
    expect(job.uses).toBe('./.github/workflows/e2e.yml')
    expect(job.if).toBe("needs.code_paths.outputs.orchestration_e2e == 'true'")
    expect(job.with.test_files).toBe('${{ needs.code_paths.outputs.orchestration_test_files }}')
    expect(job.with.ref).toBe('${{ github.event.pull_request.head.sha }}')
    expect(prWorkflow.jobs.code_paths.outputs.orchestration_e2e).toBe(
      '${{ steps.e2e_filter.outputs.orchestration_e2e }}'
    )
    expect(prWorkflow.jobs.code_paths.outputs.orchestration_test_files).toBe(
      '${{ steps.e2e_filter.outputs.orchestration_test_files }}'
    )
    expect(filterStep.run).toContain('pr-e2e-source-routing.mjs --orchestration-specs')
    expect(filterStep.run).toContain('pr-e2e-source-routing.mjs --orchestration-source')
    expect(filterStep.run).toContain('pr-e2e-source-routing.mjs --advisory-specs')
  })

  it('keeps the orchestration specs out of the lane exclusions that would skip them', () => {
    // Why: changed-e2e drops specs owned by dedicated lanes. An orchestration spec landing in
    // that jq filter would make the blocking job green without running anything.
    const changedRun = e2eWorkflow.jobs['changed-e2e'].steps.find(
      (step) => step.name === 'Run changed E2E specs'
    )
    for (const spec of route.specs) {
      expect(changedRun.run, spec).not.toContain(`!= "${spec}"`)
    }
    expect(e2eWorkflow.jobs['changed-e2e'].if).toBe("inputs.test_files != ''")
  })

  it('gives each caller of e2e.yml its own artifact namespace', () => {
    // Why: pr.yml now calls e2e.yml twice in one run. upload-artifact fails outright when two
    // jobs in a run upload one name, so without distinct suffixes a PR touching orchestration
    // source AND another routed source kills whichever `build` uploads e2e-build-out second --
    // taking a required check red for a reason that has nothing to do with the PR.
    const callers = Object.entries(prWorkflow.jobs).filter(
      ([, job]) => job.uses === './.github/workflows/e2e.yml'
    )
    expect(callers.length).toBeGreaterThan(1)
    const suffixes = callers.map(([, job]) => String(job.with?.artifact_suffix ?? ''))
    expect(new Set(suffixes).size, `duplicate artifact_suffix among ${suffixes.join(', ')}`).toBe(
      callers.length
    )
    expect(prWorkflow.jobs.orchestration_e2e.with.artifact_suffix).toBe('-orchestration')
    // The advisory caller keeps the empty default so schedule and dispatch runs, which pass no
    // inputs at all, land on the same artifact names they always have.
    expect(prWorkflow.jobs.e2e.with.artifact_suffix).toBeUndefined()
    expect(e2eWorkflow.on.workflow_call.inputs.artifact_suffix).toMatchObject({
      required: false,
      default: '',
      type: 'string'
    })
  })

  it('suffixes every artifact e2e.yml uploads or downloads', () => {
    // Why every one, not just e2e-build-out: a trace upload that kept a bare name would fail the
    // job only when a spec fails in both lanes -- a red that appears exactly when the suite is
    // already telling you something, and hides it.
    const artifactSteps = Object.values(e2eWorkflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => /^actions\/(?:upload|download)-artifact@/.test(step.uses ?? ''))
    expect(artifactSteps.length).toBeGreaterThan(0)
    for (const step of artifactSteps) {
      expect(step.with?.name, JSON.stringify(step.with)).toMatch(
        /\$\{\{ inputs\.artifact_suffix \}\}$/
      )
    }
    // A concurrency group would serialize or cancel one call against the other; e2e.yml has none
    // and must not grow one without keying it the same way.
    expect(e2eWorkflow.concurrency).toBeUndefined()
    for (const job of Object.values(e2eWorkflow.jobs)) {
      expect(job.concurrency).toBeUndefined()
    }
  })
})
