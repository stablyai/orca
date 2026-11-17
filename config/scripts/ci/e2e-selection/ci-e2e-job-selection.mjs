import { pathToFileURL } from 'node:url'

export const NODE_NETWORK_E2E_SPEC =
  'tests/e2e/remote/ssh-hosts/ssh-browser-network-execution-route.docker.unit.test.ts'
export const NATIVE_IME_E2E_SPEC = 'tests/e2e/terminal/ime/terminal-ibus-hangul-native.spec.ts'
// Needs the packaged orcad slot, which only its own job builds.
export const ORCAD_SERVE_MODE_SWITCH_E2E_SPEC =
  'tests/e2e/remote/managed-ssh/host-lifecycle/orcad-serve-mode-switch.spec.ts'
// Windows-only; its own job runs it on a Windows runner.
export const WINDOWS_MISSING_APPDATA_E2E_SPEC =
  'tests/e2e/desktop/startup-recovery/windows-missing-appdata-startup.spec.ts'
// Windows-only; the same Windows job runs it.
export const WINDOWS_COPY_FILE_E2E_SPEC =
  'tests/e2e/editor/file-explorer/file-explorer-copy-file-windows.spec.ts'
// Managed-SSH specs need the orcad template built by their Docker lane.
export const MANAGED_SSH_E2E_SPECS = [
  'tests/e2e/remote/managed-ssh/file-lifecycle/ssh-orcad-editor-watch-recovery.spec.ts',
  'tests/e2e/remote/managed-ssh/file-lifecycle/ssh-orcad-explorer-watch-recovery.spec.ts',
  'tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-idle-exit.spec.ts',
  'tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-pairing-repair.spec.ts',
  'tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-shared-home-machines.spec.ts',
  'tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-unbindable-tunnel-port.spec.ts',
  'tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-update-anyway.spec.ts'
]
const managedSshSpecs = new Set(MANAGED_SSH_E2E_SPECS)
export const DEDICATED_E2E_SPECS = [
  NODE_NETWORK_E2E_SPEC,
  NATIVE_IME_E2E_SPEC,
  ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
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
  return dedicatedSpecs.has(spec) || managedSshSpecs.has(spec)
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

export function generalE2eShards(input) {
  if (input === '') {
    return ['1/1']
  }
  const count = new Set(selectGeneralE2eSpecs(parseSpecs(input))).size
  // Broad selections need the nightly suite's shard capacity; small PRs retain one VM.
  const shards = Math.min(14, Math.max(1, Math.ceil(count / 25)))
  return Array.from({ length: shards }, (_, index) => `${index + 1}/${shards}`)
}

export function selectManagedSshE2eSpecs(input) {
  if (input === '') {
    return MANAGED_SSH_E2E_SPECS
  }
  const specs = [...new Set(parseSpecs(input))].filter((spec) => managedSshSpecs.has(spec))
  if (specs.length === 0) {
    throw new Error('Expected at least one managed SSH spec')
  }
  return specs
}

export function managedSshShards(input) {
  try {
    if (selectManagedSshE2eSpecs(input).length <= 2) {
      return ['1/1']
    }
  } catch {
    // Invalid evidence keeps the full allocation; the test consumer rejects it.
  }
  return ['1/2', '2/2']
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
    process.stdout.write(`e2e_ssh_shards=${JSON.stringify(managedSshShards(input))}\n`)
  } else {
    for (const spec of selectGeneralE2eSpecs(parseSpecs(input))) {
      if (/[\r\n]/.test(spec)) {
        throw new Error('E2E spec paths cannot contain newlines')
      }
      process.stdout.write(`${spec}\n`)
    }
  }
}
