import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'

const NODE_VERSION = '24.18.0'
const NODE_PTY_VERSION = '1.1.0'
const PARCEL_WATCHER_VERSION = '2.5.6'

const WATCHER_PACKAGES = Object.freeze({
  'linux-x64-glibc': '@parcel/watcher-linux-x64-glibc',
  'linux-arm64-glibc': '@parcel/watcher-linux-arm64-glibc',
  'darwin-x64': '@parcel/watcher-darwin-x64',
  'darwin-arm64': '@parcel/watcher-darwin-arm64',
  'win32-x64': '@parcel/watcher-win32-x64',
  'win32-arm64': '@parcel/watcher-win32-arm64'
})

const COMMON_FILES = Object.freeze([
  '.version',
  'THIRD_PARTY_LICENSES.txt',
  'node_modules/@parcel/watcher/index.js',
  'node_modules/@parcel/watcher/package.json',
  'node_modules/@parcel/watcher/wrapper.js',
  'node_modules/detect-libc/lib/detect-libc.js',
  'node_modules/detect-libc/lib/elf.js',
  'node_modules/detect-libc/lib/filesystem.js',
  'node_modules/detect-libc/lib/process.js',
  'node_modules/detect-libc/package.json',
  'node_modules/is-extglob/index.js',
  'node_modules/is-extglob/package.json',
  'node_modules/is-glob/index.js',
  'node_modules/is-glob/package.json',
  'node_modules/node-pty/lib/eventEmitter2.js',
  'node_modules/node-pty/lib/index.js',
  'node_modules/node-pty/lib/terminal.js',
  'node_modules/node-pty/lib/utils.js',
  'node_modules/node-pty/package.json',
  'node_modules/picomatch/index.js',
  'node_modules/picomatch/lib/constants.js',
  'node_modules/picomatch/lib/parse.js',
  'node_modules/picomatch/lib/picomatch.js',
  'node_modules/picomatch/lib/scan.js',
  'node_modules/picomatch/lib/utils.js',
  'node_modules/picomatch/package.json',
  'relay-watcher.js',
  'relay.js',
  'runtime-metadata.json'
])

const POSIX_NODE_PTY_FILES = Object.freeze([
  'node_modules/node-pty/build/Release/pty.node',
  'node_modules/node-pty/lib/unixTerminal.js'
])

const WINDOWS_NODE_PTY_FILES = Object.freeze([
  'node_modules/node-pty/build/Release/conpty.node',
  'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
  'node_modules/node-pty/build/Release/conpty/conpty.dll',
  'node_modules/node-pty/build/Release/conpty_console_list.node',
  'node_modules/node-pty/lib/conpty_console_list_agent.js',
  'node_modules/node-pty/lib/shared/conout.js',
  'node_modules/node-pty/lib/windowsConoutConnection.js',
  'node_modules/node-pty/lib/windowsPtyAgent.js',
  'node_modules/node-pty/lib/windowsTerminal.js',
  'node_modules/node-pty/lib/worker/conoutSocketWorker.js'
])

export function sshRelayRuntimeWatcherPackage(tuple) {
  const packageName = WATCHER_PACKAGES[tuple]
  if (!packageName) {
    throw new Error(`No bundled Parcel watcher package is defined for ${tuple}`)
  }
  return packageName
}

export function sshRelayRuntimeFileRole(path) {
  if (path === 'bin/node' || path === 'bin/node.exe') {
    return 'node'
  }
  if (path === 'relay.js') {
    return 'relay'
  }
  if (path === 'relay-watcher.js') {
    return 'relay-watcher'
  }
  if (/\/(?:pty|conpty|conpty_console_list)\.node$/.test(path)) {
    return 'node-pty-native'
  }
  if (path.endsWith('/watcher.node')) {
    return 'parcel-watcher-native'
  }
  if (
    path.endsWith('/spawn-helper') ||
    path.endsWith('/conpty/conpty.dll') ||
    path.endsWith('/conpty/OpenConsole.exe')
  ) {
    return 'native-runtime'
  }
  if (path === 'THIRD_PARTY_LICENSES.txt') {
    return 'license'
  }
  return 'runtime-javascript'
}

function expectedFiles(tuple) {
  const watcherPackage = sshRelayRuntimeWatcherPackage(tuple)
  const paths = [
    ...COMMON_FILES,
    tuple.startsWith('win32-') ? 'bin/node.exe' : 'bin/node',
    `node_modules/${watcherPackage}/package.json`,
    `node_modules/${watcherPackage}/watcher.node`,
    ...(tuple.startsWith('win32-') ? WINDOWS_NODE_PTY_FILES : POSIX_NODE_PTY_FILES)
  ]
  if (tuple.startsWith('darwin-')) {
    paths.push('node_modules/node-pty/build/Release/spawn-helper')
  }
  return paths.sort().map((path) => {
    const role = sshRelayRuntimeFileRole(path)
    const mode = ['node', 'node-pty-native', 'parcel-watcher-native', 'native-runtime'].includes(
      role
    )
      ? 0o755
      : 0o644
    return { path, type: 'file', role, mode }
  })
}

function expectedDirectories(files) {
  const paths = new Set()
  for (const file of files) {
    const segments = file.path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      paths.add(segments.slice(0, depth).join('/'))
    }
  }
  return [...paths].sort().map((path) => ({ path, type: 'directory', mode: 0o755 }))
}

export function expectedSshRelayRuntimeClosureEntries(tuple) {
  const files = expectedFiles(tuple)
  return [...expectedDirectories(files), ...files]
}

function indexEntries(entries, type) {
  const indexed = new Map()
  for (const entry of entries.filter((candidate) => candidate.type === type)) {
    if (indexed.has(entry.path)) {
      throw new Error(`Runtime closure contains a duplicate ${type}: ${entry.path}`)
    }
    indexed.set(entry.path, entry)
  }
  return indexed
}

function assertExactEntries(actualEntries, expectedEntries, type) {
  const actual = indexEntries(actualEntries, type)
  const expected = indexEntries(expectedEntries, type)
  for (const [path, contract] of expected) {
    const entry = actual.get(path)
    if (!entry) {
      throw new Error(`Runtime closure is missing required ${type}: ${path}`)
    }
    for (const field of type === 'file' ? ['role', 'mode'] : ['mode']) {
      if (entry[field] !== contract[field]) {
        throw new Error(`Runtime closure ${type} has unexpected ${field}: ${path}`)
      }
    }
    actual.delete(path)
  }
  if (actual.size > 0) {
    throw new Error(`Runtime closure contains undeclared ${type}: ${actual.keys().next().value}`)
  }
}

export function assertSshRelayRuntimeClosureEntries(identity) {
  if (
    identity.nodeVersion !== NODE_VERSION ||
    identity.dependencies?.nodePtyVersion !== NODE_PTY_VERSION ||
    identity.dependencies?.parcelWatcherVersion !== PARCEL_WATCHER_VERSION
  ) {
    // Why: dependency refreshes require a reviewed desktop release and a new immutable manifest.
    throw new Error('Runtime closure dependency versions do not match the reviewed contract')
  }
  const expected = expectedSshRelayRuntimeClosureEntries(identity.tupleId)
  assertExactEntries(identity.entries, expected, 'directory')
  assertExactEntries(identity.entries, expected, 'file')
}

function expectedPackages(tuple) {
  const watcherPackage = sshRelayRuntimeWatcherPackage(tuple)
  return [
    { name: 'node-pty', version: NODE_PTY_VERSION, main: './lib/index.js', license: 'MIT' },
    { name: '@parcel/watcher', version: PARCEL_WATCHER_VERSION, main: 'index.js', license: 'MIT' },
    { name: watcherPackage, version: PARCEL_WATCHER_VERSION, main: 'watcher.node', license: 'MIT' },
    { name: 'detect-libc', version: '2.1.2', main: 'lib/detect-libc.js', license: 'Apache-2.0' },
    { name: 'is-glob', version: '4.0.3', main: 'index.js', license: 'MIT' },
    { name: 'is-extglob', version: '2.1.1', main: 'index.js', license: 'MIT' },
    { name: 'picomatch', version: '4.0.4', main: 'index.js', license: 'MIT' }
  ]
}

function assertLicenseSections(text, packageNames) {
  const matches = [...text.matchAll(/^===== ([^\r\n]+) =====$/gm)]
  const names = matches.map((match) => match[1])
  if (!isDeepStrictEqual(names, ['Node.js', ...packageNames])) {
    throw new Error('Runtime license bundle does not match the exact package closure')
  }
  for (let index = 0; index < matches.length; index += 1) {
    const bodyStart = matches[index].index + matches[index][0].length
    const bodyEnd = matches[index + 1]?.index ?? text.length
    if (text.slice(bodyStart, bodyEnd).trim().length === 0) {
      throw new Error(`Runtime license bundle has an empty section: ${matches[index][1]}`)
    }
  }
}

export async function verifySshRelayRuntimeClosure(runtimeRoot, identity) {
  assertSshRelayRuntimeClosureEntries(identity)
  const packages = expectedPackages(identity.tupleId)
  for (const expected of packages) {
    const path = join(runtimeRoot, 'node_modules', ...expected.name.split('/'), 'package.json')
    const actual = JSON.parse(await readFile(path, 'utf8'))
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `Runtime package metadata does not match the closure contract: ${expected.name}`
      )
    }
  }
  const [licenseText, versionText, metadataText] = await Promise.all([
    readFile(join(runtimeRoot, 'THIRD_PARTY_LICENSES.txt'), 'utf8'),
    readFile(join(runtimeRoot, '.version'), 'utf8'),
    readFile(join(runtimeRoot, 'runtime-metadata.json'), 'utf8')
  ])
  assertLicenseSections(
    licenseText,
    packages.map((entry) => entry.name)
  )
  const metadata = JSON.parse(metadataText)
  if (
    metadata.schemaVersion !== 1 ||
    metadata.tuple !== identity.tupleId ||
    metadata.nodeVersion !== identity.nodeVersion ||
    metadata.relayBuildVersion !== versionText.trim() ||
    !isDeepStrictEqual(metadata.dependencies, {
      nodePtyVersion: NODE_PTY_VERSION,
      parcelWatcherVersion: PARCEL_WATCHER_VERSION
    })
  ) {
    throw new Error('Runtime metadata does not match the exact package closure')
  }
  return { files: identity.entries.filter((entry) => entry.type === 'file').length, packages: 7 }
}
