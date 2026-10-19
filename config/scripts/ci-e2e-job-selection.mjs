import { pathToFileURL } from 'node:url'

export const NODE_NETWORK_E2E_SPEC =
  'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts'
export const NATIVE_IME_E2E_SPEC = 'tests/e2e/terminal-ibus-hangul-native.spec.ts'
// Needs the packaged orcad slot, which only its own job builds.
export const ORCAD_SERVE_MODE_SWITCH_E2E_SPEC = 'tests/e2e/orcad-serve-mode-switch.spec.ts'
// Windows-only; its own job runs it on a Windows runner.
export const WINDOWS_MISSING_APPDATA_E2E_SPEC = 'tests/e2e/windows-missing-appdata-startup.spec.ts'
// Windows-only; the same Windows job runs it.
export const WINDOWS_COPY_FILE_E2E_SPEC = 'tests/e2e/file-explorer-copy-file-windows.spec.ts'
// Needs out/orcad, which only the mode-switch job builds; it runs there beside that spec.
export const LAYOUT_ORACLE_HEADLESS_E2E_SPEC = 'tests/e2e/workspace-layout-oracle-headless.spec.ts'
// One Docker job runs every managed-SSH spec; it builds the orcad template they need.
export const MANAGED_SSH_E2E_SPEC_PREFIX = 'tests/e2e/ssh-orcad-'
export const DEDICATED_E2E_SPECS = [
  NODE_NETWORK_E2E_SPEC,
  NATIVE_IME_E2E_SPEC,
  ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
  LAYOUT_ORACLE_HEADLESS_E2E_SPEC,
  WINDOWS_MISSING_APPDATA_E2E_SPEC,
  WINDOWS_COPY_FILE_E2E_SPEC
]
const dedicatedSpecs = new Set(DEDICATED_E2E_SPECS)
// Their jobs build their own app or none, so they never need the shared e2e build.
const OWN_BUILD_E2E_SPECS = new Set([
  NODE_NETWORK_E2E_SPEC,
  NATIVE_IME_E2E_SPEC,
  WINDOWS_MISSING_APPDATA_E2E_SPEC,
  WINDOWS_COPY_FILE_E2E_SPEC
])

export function isDedicatedE2eSpec(spec) {
  return dedicatedSpecs.has(spec) || spec.startsWith(MANAGED_SSH_E2E_SPEC_PREFIX)
}

export function selectGeneralE2eSpecs(specs) {
  return specs.filter((spec) => !isDedicatedE2eSpec(spec))
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
  return {
    e2e_run_changed: selectGeneralE2eSpecs(specs).length > 0,
    e2e_needs_build: specs.some((spec) => !OWN_BUILD_E2E_SPECS.has(spec))
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
