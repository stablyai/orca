import { pathToFileURL } from 'node:url'

export const DOCKER_SSH_E2E_SPECS = [
  'tests/e2e/local-ssh-browser-routing.spec.ts',
  'tests/e2e/ssh-client-hosted-browser-drop-reconnect.spec.ts',
  'tests/e2e/pty-input-write-queue-ssh.spec.ts',
  'tests/e2e/ssh-ai-vault-session-history.spec.ts',
  'tests/e2e/ssh-codex-display-artifacts-repro.spec.ts',
  'tests/e2e/ssh-cold-activation-restore.spec.ts',
  'tests/e2e/ssh-cold-hydration-gap-tab-seeding.spec.ts',
  'tests/e2e/ssh-emptied-worktree-reactivation.spec.ts',
  'tests/e2e/ssh-docker-five-pane-input-under-flood.spec.ts',
  'tests/e2e/ssh-docker-bulk-open-freeze-repro.spec.ts',
  'tests/e2e/ssh-docker-half-open-link.spec.ts',
  'tests/e2e/ssh-docker-quick-open-large-listing.spec.ts',
  'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts',
  'tests/e2e/ssh-docker-relay-stall-credential.spec.ts',
  'tests/e2e/ssh-docker-resource-accumulation.spec.ts',
  'tests/e2e/ssh-docker-transport-drop-recovery.spec.ts',
  'tests/e2e/ssh-external-image-preview.spec.ts',
  'tests/e2e/ssh-lost-kill-tab-resurrection.spec.ts',
  'tests/e2e/ssh-pi-compatible-agent-title.spec.ts',
  'tests/e2e/ssh-port-forward-lifecycle.spec.ts',
  'tests/e2e/ssh-reattach-home-partition.spec.ts',
  'tests/e2e/ssh-reconnect-tab-destruction.spec.ts',
  'tests/e2e/ssh-restart-tab-accumulation.spec.ts',
  'tests/e2e/ssh-skill-installation.spec.ts',
  'tests/e2e/ssh-stale-resume-execution-host-scope.spec.ts',
  'tests/e2e/ssh-terminal-window-wake-stale-grid-repro.spec.ts',
  'tests/e2e/terminal-inline-images-ssh.spec.ts',
  'tests/e2e/ssh-docker-watcher-isolation.spec.ts',
  'tests/e2e/ssh-terminal-parking.spec.ts',
  'tests/e2e/terminal-retention-budget.spec.ts',
  'tests/e2e/ssh-startup-exec-readiness.spec.ts',
  'tests/e2e/paired-startup-exec-readiness.spec.ts'
]

export const NODE_NETWORK_E2E_SPEC =
  'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts'
export const LOCALHOST_SSH_E2E_SPEC = 'tests/e2e/ssh-localhost.spec.ts'
export const NATIVE_IME_E2E_SPEC = 'tests/e2e/terminal-ibus-hangul-native.spec.ts'
// Needs the packaged orcad slot, which only its own job builds.
export const ORCAD_SERVE_MODE_SWITCH_E2E_SPEC = 'tests/e2e/orcad-serve-mode-switch.spec.ts'
// Needs the orcad template for its host's target, which only its own job builds.
export const ORCAD_AUTO_CONVERT_E2E_SPEC = 'tests/e2e/ssh-orcad-auto-convert.spec.ts'
// Windows-only; its own job runs it on a Windows runner.
export const WINDOWS_MISSING_APPDATA_E2E_SPEC = 'tests/e2e/windows-missing-appdata-startup.spec.ts'
// Runs in the auto-convert job, which builds the template it needs.
export const ORCAD_IDLE_EXIT_E2E_SPEC = 'tests/e2e/ssh-orcad-idle-exit.spec.ts'
export const DEDICATED_E2E_SPECS = [
  ...DOCKER_SSH_E2E_SPECS,
  NODE_NETWORK_E2E_SPEC,
  LOCALHOST_SSH_E2E_SPEC,
  NATIVE_IME_E2E_SPEC,
  ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
  ORCAD_AUTO_CONVERT_E2E_SPEC,
  WINDOWS_MISSING_APPDATA_E2E_SPEC,
  ORCAD_IDLE_EXIT_E2E_SPEC
]
const dedicatedSpecs = new Set(DEDICATED_E2E_SPECS)
const dockerSpecs = new Set(DOCKER_SSH_E2E_SPECS)

export function selectGeneralE2eSpecs(specs) {
  return specs.filter((spec) => !dedicatedSpecs.has(spec))
}

function parseSpecs(input) {
  const specs = JSON.parse(input)
  if (!Array.isArray(specs) || specs.some((spec) => typeof spec !== 'string' || !spec)) {
    throw new Error('Expected a JSON array of nonempty E2E spec paths')
  }
  return specs
}

export function classifyE2eJobs(input, sshSourceChanged = 'false') {
  const conservative = { e2e_run_changed: true, e2e_needs_build: true }
  let specs
  try {
    specs = parseSpecs(input)
  } catch {
    return conservative
  }
  // Empty evidence keeps allocations; the consumer still validates its input.
  if (specs.length === 0) {
    return conservative
  }
  const runChanged = selectGeneralE2eSpecs(specs).length > 0
  return {
    e2e_run_changed: runChanged,
    e2e_needs_build:
      runChanged ||
      sshSourceChanged !== 'false' ||
      specs.some(
        (spec) =>
          dockerSpecs.has(spec) ||
          spec === LOCALHOST_SSH_E2E_SPEC ||
          spec === ORCAD_SERVE_MODE_SWITCH_E2E_SPEC ||
          spec === ORCAD_AUTO_CONVERT_E2E_SPEC ||
          spec === ORCAD_IDLE_EXIT_E2E_SPEC
      )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
  }
  if (process.argv.includes('--job-outputs')) {
    for (const [name, value] of Object.entries(
      classifyE2eJobs(input, process.env.E2E_SSH_SOURCE_CHANGED ?? 'false')
    )) {
      process.stdout.write(`${name}=${value}\n`)
    }
  } else {
    for (const spec of selectGeneralE2eSpecs(parseSpecs(input))) {
      if (/[\r\n]/.test(spec)) {
        throw new Error('E2E spec paths cannot contain newlines')
      }
      process.stdout.write(`${spec}\n`)
    }
  }
}
