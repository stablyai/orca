// The glibc 2.17 lane builds and smokes native slots; it does not run the server tests.
export const NATIVE_COMPAT_ENTRY_POINTS = [
  'config/scripts/build-orcad-prebuilds.mjs',
  'config/scripts/orcad-prebuild-smoke.mjs',
  'config/scripts/orcad-prebuild-smoke-child.cjs',
  // createRequire and the smoke subprocess do not expose these edges to esbuild.
  'config/scripts/node-pty-job-ownership.cjs',
  'config/scripts/verify-linux-glibc-floor.cjs'
]

// These files configure or support tests; additions/deletions still require qualification.
const MODIFIED_TEST_INPUTS = new Set([
  'config/reliability-gates.jsonc',
  'src/main/daemon/serialize-grid-variant-scope.ts',
  'config/scripts/vitest-sqlite-database-runtime-files.mjs',
  'src/main/native-chat/agent-session-journal/journal-host-database-test-support.ts'
])

function isRepositoryPath(file) {
  return (
    typeof file === 'string' &&
    file.length > 0 &&
    !file.startsWith('/') &&
    !file.includes(':') &&
    !/[\\\0\r\n]/.test(file) &&
    file.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

function isOrdinaryChange(header) {
  const match =
    /^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([ADM])$/.exec(
      header
    )
  if (!match) {
    return false
  }
  const [, beforeMode, afterMode, before, after, status] = match
  if (before.length !== after.length) {
    return false
  }
  const ordinary = (mode) => mode === '100644' || mode === '100755'
  const absent = (mode, hash) => mode === '000000' && /^0+$/.test(hash)
  const present = (mode, hash) => ordinary(mode) && !/^0+$/.test(hash)
  if (status === 'A') {
    return absent(beforeMode, before) && present(afterMode, after)
  }
  if (status === 'D') {
    return present(beforeMode, before) && absent(afterMode, after)
  }
  return present(beforeMode, before) && present(afterMode, after)
}

export function readNativeCompatDiff(changedFiles, rawDiff) {
  if (
    changedFiles.length === 0 ||
    new Set(changedFiles).size !== changedFiles.length ||
    !changedFiles.every(isRepositoryPath) ||
    typeof rawDiff !== 'string' ||
    !rawDiff.endsWith('\0')
  ) {
    return null
  }
  const fields = rawDiff.slice(0, -1).split('\0')
  if (fields.length !== changedFiles.length * 2) {
    return null
  }
  const entries = []
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index]
    const file = fields[index + 1]
    if (!isOrdinaryChange(header) || !isRepositoryPath(file)) {
      return null
    }
    entries.push({ status: header.slice(-1), file })
  }
  const files = new Set(entries.map(({ file }) => file))
  return files.size === changedFiles.length && changedFiles.every((file) => files.has(file))
    ? entries
    : null
}

function isTestInput({ status, file }) {
  // Build policy and process-host fixtures can be read without a static import.
  if (
    file.startsWith('src/packages/') ||
    /^config\/scripts\/[^/]*(?:orcad|node-server|node-pty|native|glibc|pinned-node|node-runtime|workspace-source-exports|script-module-dependencies)[^/]*$/.test(
      file
    )
  ) {
    return false
  }
  return (
    (status === 'M' && MODIFIED_TEST_INPUTS.has(file)) ||
    /^src\/(?:[^/]+\/)*[^/]+\.(?:test|spec)\.(?:ts|tsx)$/.test(file) ||
    /^config\/scripts\/(?:[^/]+\/)*[^/]+\.test\.(?:ts|mjs)$/.test(file) ||
    /^tests\/e2e\/(?:[^/]+\/)*[^/]+\.unit\.test\.ts$/.test(file)
  )
}

export async function classifyNativeCompatChanges(
  changedFiles,
  collect,
  { pullRequest = false, fullQualification = false, rawDiff, deferGraph = false } = {}
) {
  const required = (reason) => ({ nativeCompatibility: true, reason })
  if (!pullRequest || fullQualification) {
    return required('Native qualification is unconditional outside an ordinary PR')
  }
  const entries = readNativeCompatDiff(changedFiles, rawDiff)
  if (!entries || !entries.every(isTestInput)) {
    return required('The complete diff is not limited to recognized test inputs')
  }
  if (deferGraph) {
    return { graphRequired: true, reason: 'Native build and smoke imports must be checked' }
  }
  try {
    const inputs = await collect({ entryPoints: NATIVE_COMPAT_ENTRY_POINTS })
    if (
      !(inputs instanceof Set) ||
      ![...inputs].every(isRepositoryPath) ||
      !NATIVE_COMPAT_ENTRY_POINTS.every((file) => inputs.has(file))
    ) {
      return required('The native build and smoke input graph is incomplete')
    }
    const matched = changedFiles.find((file) => inputs.has(file))
    return matched
      ? required(`Native build or smoke input changed: ${matched}`)
      : { nativeCompatibility: false, reason: 'Only unconsumed test inputs changed' }
  } catch (error) {
    return required(`Native dependency graph unavailable: ${String(error)}`)
  }
}
