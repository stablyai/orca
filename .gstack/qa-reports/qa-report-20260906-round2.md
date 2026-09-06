# QA Report — feat/linux-serve-auto-update round 2 (2026-09-06)

Regression-diff mode: delta since QA round 1 (`821b3840a1`) through HEAD
(`3c9e87315c`). Round 1 covered the earlier branch surface; this pass verifies
the 10 commits landed after it (attempt-id binding, jq verdicts,
census-continuation handshake, semver downgrade gate, stage-before-hash,
umask 077 hardening, npx/pnpm fix, CLI 2.1.263 effort fix, harness naming).

## Delta surface (821b3840a1..HEAD, branch-owned)
- `src/main/cli/serve-update-helper-script.ts`: semver_higher downgrade gate,
  jq-built bound verdicts, pre-parse binding init, census-continuation wait,
  stage-before-hash, umask 077 staging, cheap-checks-before-staging.
- `src/main/updater/updater-serve-install-handoff.ts`: spawn-failure racing,
  census fence + continuation write before quit.
- `src/main/serve-update-spool.ts` + shared: census.ok file, attempt-id cache,
  readServeUpdateResultFor.
- `config/docker/headless-serve-update/run-update-case.sh`: census writer,
  downgrade-case binding assertions.
- No renderer feature surface changed (only test-timeout budgets in
  WorktreeCard tests and locale keys via da665f6c; WorktreeCard tests 5/5 pass).

## Functional lanes (all green on HEAD)
- Serve-update core suite (helper script, helper installer, spool, census,
  handoff, artifact-capture, headless-serve install + failures):
  52 passed | 7 skipped (59).
- Updater integration ring (install-failure-cause, rpc updater, remote-server-updater,
  src/main/startup): 494 passed | 10 skipped (504).
- Full src/cli suite: 114 files, 1077 passed | 4 skipped.
- Full-suite run at 993458728e (pre-3c9e8731): 73,659 passed, 8 failed files —
  all 8 re-run green in isolation (load-flakes at machine load 36).

## Helper behavior probes (generated script, no docker needed)
- `bash -n` on generated helper: OK.
- Pre-parse rejection as non-root with no request: exit 0, verdict written
  `{phase:"rejected", attemptId:"", targetVersion:"", reason:"helper must run as root"}`
  — clean converged state for the poller, no `set -u` crash.
- `semver_higher` decision table executed from the generated script (9/9):
  no-op, upgrade, downgrade, stable↔own-prerelease both directions,
  beta.1<beta.2, beta.9<rc.1, 1.9.9<1.10.0, beta>alpha.

## Docker E2E harness (CI-only, no docker on this machine)
- `bash -n` run-update-case.sh: OK. `node --check` runner: OK.
- mock-feed.py compiles; live HTTP smoke 200.
- New census-writer + downgrade binding assertions reviewed in the case script.

## Issues found this round
- None branch-caused. One probe-harness false alarm (my test caller passed
  args in the wrong order) — re-run correctly: 9/9 PASS.

## Health
No branch-caused issues open. Health score: 100 (no new findings).
Deferred: Docker E2E execution itself is CI-gated ("Verify headless serve
update flow" in pr.yml) — machine has no docker.
