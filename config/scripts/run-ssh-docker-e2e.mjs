import { spawnSync } from 'node:child_process'

const rawExtraArgs = process.argv.slice(2)
const extraArgs = rawExtraArgs[0] === '--' ? rawExtraArgs.slice(1) : rawExtraArgs
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const env = {
  ...process.env,
  ORCA_E2E_SSH_DOCKER: '1',
  ORCA_E2E_WEB_CLIENT: '1'
}

// Why: Node's CVE-2024-27980 hardening rejects .cmd spawns without shell on Windows.
const spawnOptions = {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
}

const runtime = spawnSync(pnpm, ['run', 'ensure:electron-runtime'], spawnOptions)

if (runtime.status !== 0) {
  process.exit(runtime.status ?? 1)
}

// Why one explicit list: these specs self-skip without ORCA_E2E_SSH_DOCKER and no sharded lane
// sets it, so a spec in no runner runs nowhere. The gate contract proves every flag-reading
// spec is claimed here, by the watcher-isolation or parking runner, or by a listed exclusion.
//
// Deliberately absent, and therefore still covered by no CI trigger:
//   ssh-docker-relay-perf.spec.ts — wall-clock latency thresholds; flaky budgets here would
//     cost the lane its credibility. NOTE: a runner script test:e2e:ssh-docker-perf exists in
//     package.json but NO workflow invokes it, so this spec currently runs in no CI lane at
//     all. Recorded as a real gap, not as coverage living somewhere else.
//   ssh-codex-display-artifacts-repro.spec.ts — installs a real remote codex binary that CI
//     runners do not have (observed as `spawn codex ENOENT`). Runs in no CI lane at all.
//   ssh-docker-bulk-open-freeze-repro.spec.ts — un-rotted and now measurable, and marked
//     `test.fixme` because its oracle cannot gate. Absent from this list AND skipped, so the
//     two cannot drift: it is also reachable from the changed-specs lane whenever the spec
//     itself is edited, and a wall-clock oracle that fails there is worth no more than one
//     that fails here.
//     The rot (#16764) is fixed: the stale call sites are repaired, it connects after session
//     restore instead of before, and readiness keys on the repeating flood marker rather than
//     a one-shot READY line the flood buries within ~16ms. It runs end to end and prints a
//     measurement instead of dying on a call site.
//     What it is NOT is portable. Three runs of the same measurement path:
//       developer workstation:   hiddenFlood 2.1ms  bulkOpen   41.5ms  interaction   53.6ms
//       GitHub ubuntu runner A:  hiddenFlood 1.5ms  bulkOpen 2575.6ms  interaction 3464.2ms
//       GitHub ubuntu runner B:  hiddenFlood 0.2ms  bulkOpen  397.4ms  interaction 3386.7ms
//     bulkOpen swings 6.5x between two CI runs of the same code, so a fixed threshold on it is
//     a coin flip; interaction sits stably ~64x over the workstation figure because it times a
//     view remount, not the renderer freeze the issue reports, and only shares the budget
//     constant because both are milliseconds. Every failure so far is the soft budget; hard
//     has never tripped, and the relay was still streaming each time — the budget failed, not
//     the product. Same rule as ssh-docker-relay-perf above. Gating needs a distribution
//     first, then a host-relative oracle; a bigger constant, or a ratio picked from three
//     samples, is the same arbitrary number in different clothes.
//     COVERAGE GAP, recorded as such: 5 simultaneously flooding SSH panes exercise writer
//     saturation, ACK/credit accounting and per-pane polling together, and nothing else covers
//     that combination. Flip `test.fixme` back to `test` to run it. Tracked in
//     stablyai/orca#16764.
//
// Why both projects: ssh-port-forward-lifecycle is @headful, which the headless project
// grep-inverts away.
//
// Known gaps in SSH e2e coverage, recorded here because nothing else names them:
//   - The job that runs this is still called `ssh-docker-watcher-isolation`, though watcher
//     isolation is now one spec of many. Renaming it changes the GitHub check name and can
//     break required-check config, so the name understates the job on purpose.
//   - E2E does not gate merges: `verify.needs` in pr.yml omits `e2e` while the suite is red on
//     main. Nothing in this lane blocks a PR yet. pr.yml's Require-successful-checks comment
//     has the exact wiring to flip it, and the gate contract asserts the current state.
//   - Five specs and one unit test are gated on env vars no workflow sets, so they run nowhere
//     and are not Docker-gated, which puts them outside this file's contract:
//       local-ssh-browser-routing (ORCA_E2E_LOCAL_SSH_BROWSER)
//       ssh-client-hosted-browser-drop-reconnect (ORCA_E2E_SSH_CLIENT_HOSTED_BROWSER)
//       nested-runtime-ssh-lifecycle, nested-runtime-ssh-routing (ORCA_E2E_NESTED_RUNTIME_SSH)
//       ssh-localhost (ORCA_E2E_SSH_LOCALHOST)
//       ssh-browser-network-execution-route.docker.unit.test.ts (ORCA_RUN_DOCKER_SSH_BROWSER_E2E)
//     Runner scripts for the first four sit unused in package.json; no workflow calls them.
const result = spawnSync(
  pnpm,
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/pty-input-write-queue-ssh.spec.ts',
    'tests/e2e/ssh-ai-vault-session-history.spec.ts',
    'tests/e2e/ssh-cold-activation-restore.spec.ts',
    'tests/e2e/ssh-cold-hydration-gap-tab-seeding.spec.ts',
    'tests/e2e/ssh-docker-half-open-link.spec.ts',
    'tests/e2e/ssh-docker-quick-open-large-listing.spec.ts',
    'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts',
    'tests/e2e/ssh-docker-resource-accumulation.spec.ts',
    'tests/e2e/ssh-docker-transport-drop-recovery.spec.ts',
    'tests/e2e/ssh-external-image-preview.spec.ts',
    'tests/e2e/ssh-lost-kill-tab-resurrection.spec.ts',
    'tests/e2e/ssh-pi-compatible-agent-title.spec.ts',
    'tests/e2e/ssh-port-forward-lifecycle.spec.ts',
    'tests/e2e/ssh-reconnect-tab-destruction.spec.ts',
    'tests/e2e/ssh-restart-tab-accumulation.spec.ts',
    'tests/e2e/ssh-skill-installation.spec.ts',
    'tests/e2e/ssh-terminal-window-wake-stale-grid-repro.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--project',
    'electron-headful',
    '--workers=1',
    ...extraArgs
  ],
  spawnOptions
)

process.exit(result.status ?? 1)
