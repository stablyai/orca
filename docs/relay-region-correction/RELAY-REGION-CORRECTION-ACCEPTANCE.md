# Idle regional correction acceptance

Updated 2026-09-11. Scope: [idle-cutover plan](RELAY-REGION-CORRECTION-IDLE-CUTOVER-PLAN.md).
Local implementation is based on main `74cc9b50390b481009b34823a35eee01a5b90e40`,
with uncommitted changes atop `08c0802089a9186cf48ce0d168cd87565bd92d65`.

**Local validation is green; the published PRs are not updated or merge-ready.**
Cloud draft20037 still points to `0462a87011d8783f91f9a9e977ea7a68437a0d5b`;
desktop draft20031 still points to `f9e5b0193448e6c524603836b9278878b96cf51c`.
Their older CI is not evidence for this implementation. No commit, push, merge,
deployment, workflow dispatch or production mutation occurred in this continuation.

## What the implementation proves

The source permits optimization only when actual client sockets, splices, pending
connections and in-flight admission/control work are absent. It installs the local
gate before awaiting a constrained assignment transaction. Duplicate requests bind
exact authority; ambiguous database outcomes keep the source fenced until locked
reconciliation establishes the result. After commit, it releases the empty control
and uses ordinary reconnect and migration recovery. Emergency drains retain their
existing behavior. No retained-source protocol or restoration loop remains.

Three real TCP WebSocket scenarios join authenticated local HTTP dispatch, two
cells, the actual desktop origin pool, SQLite and an independent execution child:

1. Either connected device prevents movement; after both leave, target reconnect
   succeeds and the durable append-once mutation oracle shows no replay.
2. A racing arrival receives4409; a definite failed commit restores source admission.
3. The target control connection is actually attempted and fails; source activity
   is released and ordinary expiry recovery allows source epoch3 reconnect.

These use synthetic time and token verification. They do not prove physical mobile
background scheduling, production authentication/network behavior or user latency.

## Commands and results

Every test/app command uses `ORCA_BACKGROUND_LAUNCH=1`. Cloud commands run from
`cloud/apps/relay`; root commands run from this worktree. All logs below are under
`.tmp/idle-cutover-review/`.

| Scope | Command | Result / log |
| --- | --- | --- |
| Cloud | `ORCA_RELAY_TEST_POSTGRES_URL='postgresql://postgres@127.0.0.1:55440/postgres?options=-csearch_path%3Didle_full_root_20260911' ORCA_IDLE_REHOME_POSTGRES_URL='postgresql://postgres@127.0.0.1:55440/postgres' ORCA_REGION_CORRECTION_POSTGRES=1 pnpm exec vitest run --no-file-parallelism` |77 files /682 passed /zero skips; `cloud-full-postgres-idle.log` |
| Cloud | `pnpm run typecheck` | Passed; `cloud-typecheck-after-preview.log` |
| Cloud | `pnpm build` | Passed; `cloud-release-build-idle.log` |
| Root | `pnpm test src/main/runtime/relay` |20 files /177 passed; `desktop-relay-full-idle.log` |
| Root | `pnpm test tests/e2e/relay-region-correction.unit.test.ts tests/e2e/relay-region-compatibility.unit.test.ts` |16 passed; `transport-contract-cleanup.log` |
| Root | `pnpm test src/main/global-fetch-call-site-audit.test.ts tests/e2e/relay-region-correction.unit.test.ts` |4 passed after CI fixes; `ci-gaps-green.log` |
| Root | `pnpm tc:node` | Passed; `node-final-idle.log` |
| Root | `pnpm exec oxlint src/main/runtime/relay tests/e2e/relay-region-correction.unit.test.ts tests/e2e/relay-region-compatibility.unit.test.ts` | Passed; `desktop-lint-idle.log` |
| Root | `pnpm run check:code-quality:changed` | Passed,0 new findings across30 changed files; `code-quality-changed-idle.log` |
| Root | `pnpm run check:reliability-gates` |121 manifest gates passed; `reliability-idle.log` |
| Root | `ORCA_E2E_SSH_DOCKER=1 pnpm exec playwright test tests/e2e/ssh-docker-transport-drop-recovery.spec.ts tests/e2e/paired-remote-terminal-serve-restart-binding.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1` |7 passed after fresh build; `ssh-folder-idle.log` |
| Root | `node --test cloud/dev/scripts/deploy-relay-blue-green.test.mjs cloud/dev/scripts/read-relay-serving-regional-placement-version.test.mjs cloud/dev/scripts/relay-regional-rehome-workflow.test.mjs` |47 passed; `deployment-guards-idle.log` |

PostgreSQL16.15 reused the existing `orca-region-release-pg16` container on55440.
The suite used an isolated schema, dropped afterward (`cloud-full-postgres-cleanup.log`);
new concurrency tests create and clean independent schemas. No other PostgreSQL
port was used. Root oxlint ignores cloud; the configured cloud lint is TypeScript.

The seven background Electron checks cover paired folder-capable binding across
serve restart and six real Docker SSH recovery journeys: live pane, output bounds,
host-proven exit, repeated restarts, frozen-host silence and resumed input. They do
not exercise a physical phone-to-SSH regional cutover or packaged upgrade.

## Regression and review evidence

- Reconciliation: four cases fail against constant not-committed, then pass with
  locked authority checks (`reconciliation-{red,green}.log`).
- Registry: disabling pre-await admission accounting makes the arrival race fail;
  restoring it passes. Five conflicting operation-ID authority tuples fail before
  the identity fix, then all48 registry tests pass (`operation-tuple-{red,green}.log`).
- SQLite startup capability upgrade: red before upgrade logic;8 database tests pass
  afterward. Legacy controls default to not idle-capable.
- The commit placeholder negative control was run after implementation; it is
  counterfactual evidence, not a claim of chronological test-first development.
- Full PostgreSQL verification supersedes intermediate preview/legacy-test failures.
  An agent's earlier PostgreSQL safety-latch discrepancy was disproven in an
  isolated schema and explicitly withdrawn.
- Fifth GPT-6-astra low audit: **APPROVE within implementation scope**, no new blocker.
  Reviewed source barriers, exact duplicates, locked ambiguity and worker progress.
  Reviewer had migrated PostgreSQL tests, but did not author the core implementation.
  Ledger: `.tmp/idle-cutover-review/review-ledger.md`. No sixth cycle started.

## CI preparation and review artifacts

Old desktop CI failed on a stale global-fetch inventory count and missing `pg` for
the transport test. The count reproduces locally; the downstream catalog/probe
consumers already consume/cancel bodies, so the audited count is corrected.
The unit workflow installs locked cloud relay dependencies and builds their contracts.
From `cloud/`, both commands pass (`ci-relay-dependencies.log`):

- `npx --yes pnpm@10.24.0 --filter '@orca-cloud/relay...' install --frozen-lockfile --ignore-scripts`
- `npx --yes pnpm@10.24.0 --filter '@orca-cloud/relay^...' build`

Local split patches and draft bodies are in `.tmp/idle-cutover-review/`:
`cloud-idle.patch`, `desktop-idle.patch`, `cloud-pr-body.md`, `desktop-pr-body.md`.
`prepare-split.py` verifies ordered application against the stated main baseline;
`split-manifest.json` identifies the combined tree. The actual index/branches remain
unchanged. The HTML explainer is `.tmp/relay-region-explainer.html`; four stages,
failure toggle, light/dark mobile/desktop layout and browser-error checks pass.

## Remaining acceptance gaps

- Update the two draft PRs and verify fresh CI for their exact heads. The original
  handoff explicitly prohibited pushes; publication needs authorization.
- Packaged mixed-version desktop/mobile, physical-device lifecycle and platform
  transport remain unverified. Pinned wire tests are narrower evidence.
- CI soak and production RTT/interaction benefit remain unmeasured. Correction
  defaults off; deployment/enablement require the reviewed rollout procedure.
- Archive of intermediate/superseded evidence:
  `.tmp/idle-cutover-review/acceptance-history-before-final.md` and pre-rescope branch
  `relay-region-before-idle-implementation`. Earlier retention results do not prove
  the idle design or repair the superseded live-retention transport case.
