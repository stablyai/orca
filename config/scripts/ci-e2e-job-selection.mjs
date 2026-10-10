import { pathToFileURL } from 'node:url'

export const NODE_NETWORK_E2E_SPEC =
  'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts'
export const NATIVE_IME_E2E_SPEC = 'tests/e2e/terminal-ibus-hangul-native.spec.ts'
// Needs the packaged orcad slot, which only its own job builds.
export const ORCAD_SERVE_MODE_SWITCH_E2E_SPEC = 'tests/e2e/orcad-serve-mode-switch.spec.ts'
// Needs the orcad template for its host's target, which only its own job builds.
export const ORCAD_AUTO_CONVERT_E2E_SPEC = 'tests/e2e/ssh-orcad-auto-convert.spec.ts'
// Windows-only; its own job runs it on a Windows runner.
export const WINDOWS_MISSING_APPDATA_E2E_SPEC = 'tests/e2e/windows-missing-appdata-startup.spec.ts'
// Needs out/orcad, which only the mode-switch job builds; it runs there beside that spec.
export const LAYOUT_ORACLE_HEADLESS_E2E_SPEC = 'tests/e2e/workspace-layout-oracle-headless.spec.ts'
// Runs in the auto-convert job, which builds the template it needs.
export const ORCAD_IDLE_EXIT_E2E_SPEC = 'tests/e2e/ssh-orcad-idle-exit.spec.ts'
export const ORCAD_BROWSER_CAPABILITIES_E2E_SPEC =
  'tests/e2e/ssh-orcad-browser-capabilities.spec.ts'
export const ORCAD_BROWSER_SERVICE_STATUS_E2E_SPEC =
  'tests/e2e/ssh-orcad-browser-service-status.spec.ts'
export const ORCAD_BROWSER_ROUTING_E2E_SPEC = 'tests/e2e/ssh-orcad-browser-routing.spec.ts'
export const ORCAD_EDITOR_OWNERSHIP_E2E_SPEC = 'tests/e2e/ssh-orcad-editor-ownership.spec.ts'
export const ORCAD_MARKDOWN_CONVERSION_E2E_SPEC = 'tests/e2e/ssh-orcad-markdown-conversion.spec.ts'
export const ORCAD_MARKDOWN_LINK_REFRESH_E2E_SPEC =
  'tests/e2e/ssh-orcad-markdown-link-refresh.spec.ts'
export const ORCAD_MARKDOWN_LIVE_DOCUMENTS_E2E_SPEC =
  'tests/e2e/ssh-orcad-markdown-live-documents.spec.ts'
export const ORCAD_BROWSER_DROP_OWNER_E2E_SPEC = 'tests/e2e/ssh-orcad-browser-drop-owner.spec.ts'
export const ORCAD_OPEN_IN_OWNER_E2E_SPEC = 'tests/e2e/ssh-orcad-open-in-owner.spec.ts'
export const ORCAD_EDITOR_WATCH_RECOVERY_E2E_SPEC =
  'tests/e2e/ssh-orcad-editor-watch-recovery.spec.ts'
export const ORCAD_EXPLORER_WATCH_RECOVERY_E2E_SPEC =
  'tests/e2e/ssh-orcad-explorer-watch-recovery.spec.ts'
export const ORCAD_EXPLORER_SELECTED_HOST_E2E_SPEC =
  'tests/e2e/ssh-orcad-explorer-selected-host.spec.ts'
export const ORCAD_TERMINAL_ROOT_OWNER_E2E_SPEC = 'tests/e2e/ssh-orcad-terminal-root-owner.spec.ts'
export const DEDICATED_E2E_SPECS = [
  NODE_NETWORK_E2E_SPEC,
  NATIVE_IME_E2E_SPEC,
  ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
  LAYOUT_ORACLE_HEADLESS_E2E_SPEC,
  ORCAD_AUTO_CONVERT_E2E_SPEC,
  WINDOWS_MISSING_APPDATA_E2E_SPEC,
  ORCAD_IDLE_EXIT_E2E_SPEC,
  ORCAD_BROWSER_CAPABILITIES_E2E_SPEC,
  ORCAD_BROWSER_SERVICE_STATUS_E2E_SPEC,
  ORCAD_BROWSER_ROUTING_E2E_SPEC,
  ORCAD_EDITOR_OWNERSHIP_E2E_SPEC,
  ORCAD_MARKDOWN_CONVERSION_E2E_SPEC,
  ORCAD_MARKDOWN_LINK_REFRESH_E2E_SPEC,
  ORCAD_MARKDOWN_LIVE_DOCUMENTS_E2E_SPEC,
  ORCAD_OPEN_IN_OWNER_E2E_SPEC,
  ORCAD_EDITOR_WATCH_RECOVERY_E2E_SPEC,
  ORCAD_EXPLORER_WATCH_RECOVERY_E2E_SPEC,
  ORCAD_EXPLORER_SELECTED_HOST_E2E_SPEC,
  ORCAD_BROWSER_DROP_OWNER_E2E_SPEC,
  ORCAD_TERMINAL_ROOT_OWNER_E2E_SPEC
]
const dedicatedSpecs = new Set(DEDICATED_E2E_SPECS)

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

export function classifyE2eJobs(input) {
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
      specs.some(
        (spec) =>
          spec === ORCAD_SERVE_MODE_SWITCH_E2E_SPEC ||
          spec === LAYOUT_ORACLE_HEADLESS_E2E_SPEC ||
          spec === ORCAD_AUTO_CONVERT_E2E_SPEC ||
          spec === ORCAD_IDLE_EXIT_E2E_SPEC ||
          spec === ORCAD_BROWSER_CAPABILITIES_E2E_SPEC ||
          spec === ORCAD_BROWSER_SERVICE_STATUS_E2E_SPEC ||
          spec === ORCAD_BROWSER_ROUTING_E2E_SPEC ||
          spec === ORCAD_EDITOR_OWNERSHIP_E2E_SPEC ||
          spec === ORCAD_MARKDOWN_CONVERSION_E2E_SPEC ||
          spec === ORCAD_MARKDOWN_LINK_REFRESH_E2E_SPEC ||
          spec === ORCAD_MARKDOWN_LIVE_DOCUMENTS_E2E_SPEC ||
          spec === ORCAD_OPEN_IN_OWNER_E2E_SPEC ||
          spec === ORCAD_EDITOR_WATCH_RECOVERY_E2E_SPEC ||
          spec === ORCAD_EXPLORER_WATCH_RECOVERY_E2E_SPEC ||
          spec === ORCAD_EXPLORER_SELECTED_HOST_E2E_SPEC ||
          spec === ORCAD_BROWSER_DROP_OWNER_E2E_SPEC ||
          spec === ORCAD_TERMINAL_ROOT_OWNER_E2E_SPEC
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
    for (const [name, value] of Object.entries(classifyE2eJobs(input))) {
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
