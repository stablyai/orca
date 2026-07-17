import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'

import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import {
  sshRelayRuntimeFileRole,
  sshRelayRuntimeWatcherPackage,
  verifySshRelayRuntimeClosure
} from './ssh-relay-runtime-closure.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'

const require = createRequire(import.meta.url)
const MAX_FILES = 5_000
const MAX_EXPANDED_BYTES = 350 * 1024 * 1024
const MAX_FILE_BYTES = 250 * 1024 * 1024
const MAX_PATH_BYTES = 240
const MAX_PATH_DEPTH = 32
const PORTABLE_PATH = /^[A-Za-z0-9._@+/-]+$/
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function packageDirectory(name) {
  return dirname(require.resolve(`${name}/package.json`))
}

async function copyNormalized(source, destination, mode = 0o644) {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  await chmod(destination, mode)
}

async function writeJson(destination, value) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 })
  await chmod(destination, 0o644)
}

async function listFiles(directory) {
  const results = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await listFiles(path)))
    } else if (entry.isFile()) {
      results.push(path)
    } else {
      throw new Error(`Runtime source contains unsupported entry: ${path}`)
    }
  }
  return results.sort()
}

async function copyJavaScriptTree(source, destination, predicate = () => true) {
  for (const sourcePath of await listFiles(source)) {
    const relativePath = relative(source, sourcePath)
    if (predicate(relativePath)) {
      await copyNormalized(sourcePath, join(destination, relativePath))
    }
  }
}

async function minimalPackage(name) {
  const parsed = JSON.parse(await readFile(join(packageDirectory(name), 'package.json'), 'utf8'))
  return {
    name: parsed.name,
    version: parsed.version,
    main: parsed.main,
    license: parsed.license
  }
}

async function copyNodePty(buildDirectory, runtimeRoot, tuple) {
  const destination = join(runtimeRoot, 'node_modules', 'node-pty')
  const platformFiles = tuple.startsWith('win32-')
    ? [
        'conpty_console_list_agent.js',
        'eventEmitter2.js',
        'index.js',
        'terminal.js',
        'utils.js',
        'windowsConoutConnection.js',
        'windowsPtyAgent.js',
        'windowsTerminal.js',
        'shared/conout.js',
        'worker/conoutSocketWorker.js'
      ]
    : ['eventEmitter2.js', 'index.js', 'terminal.js', 'unixTerminal.js', 'utils.js']
  for (const path of platformFiles) {
    await copyNormalized(join(buildDirectory, 'lib', path), join(destination, 'lib', path))
  }
  await writeJson(join(destination, 'package.json'), await minimalPackage('node-pty'))
  const nativeNames = tuple.startsWith('win32-')
    ? ['conpty.node', 'conpty_console_list.node']
    : ['pty.node']
  for (const name of nativeNames) {
    await copyNormalized(
      join(buildDirectory, 'build', 'Release', name),
      join(destination, 'build', 'Release', name),
      0o755
    )
  }
  if (tuple.startsWith('win32-')) {
    for (const name of ['conpty.dll', 'OpenConsole.exe']) {
      await copyNormalized(
        join(buildDirectory, 'build', 'Release', 'conpty', name),
        join(destination, 'build', 'Release', 'conpty', name),
        0o755
      )
    }
  }
  if (tuple.startsWith('darwin-')) {
    await copyNormalized(
      join(buildDirectory, 'build', 'Release', 'spawn-helper'),
      join(destination, 'build', 'Release', 'spawn-helper'),
      0o755
    )
  }
}

async function copyPackageRuntime(name, runtimeRoot, relativePaths) {
  const source = packageDirectory(name)
  const destination = join(runtimeRoot, 'node_modules', ...name.split('/'))
  for (const relativePath of relativePaths) {
    const sourcePath = join(source, relativePath)
    const metadata = await stat(sourcePath)
    await (metadata.isDirectory()
      ? copyJavaScriptTree(sourcePath, join(destination, relativePath), (path) =>
          path.endsWith('.js')
        )
      : copyNormalized(sourcePath, join(destination, relativePath)))
  }
  await writeJson(join(destination, 'package.json'), await minimalPackage(name))
}

async function copyParcelWatcher(runtimeRoot, tuple) {
  const watcherPackage = sshRelayRuntimeWatcherPackage(tuple)
  await copyPackageRuntime('@parcel/watcher', runtimeRoot, ['index.js', 'wrapper.js'])
  await copyPackageRuntime(watcherPackage, runtimeRoot, ['watcher.node'])
  await chmod(
    join(runtimeRoot, 'node_modules', ...watcherPackage.split('/'), 'watcher.node'),
    0o755
  )
  await copyPackageRuntime('detect-libc', runtimeRoot, ['lib'])
  await copyPackageRuntime('is-glob', runtimeRoot, ['index.js'])
  await copyPackageRuntime('is-extglob', runtimeRoot, ['index.js'])
  await copyPackageRuntime('picomatch', runtimeRoot, ['index.js', 'lib'])
  return watcherPackage
}

async function relayBuildVersion(relayDirectory) {
  const [relay, watcher, version] = await Promise.all([
    readFile(join(relayDirectory, 'relay.js')),
    readFile(join(relayDirectory, 'relay-watcher.js')),
    readFile(join(relayDirectory, '.version'), 'utf8')
  ])
  const hash = createHash('sha256').update(relay).update(watcher).digest('hex').slice(0, 12)
  if (!version.trim().endsWith(`+${hash}`)) {
    throw new Error('Existing relay build version does not authenticate relay and watcher bytes')
  }
  return version.trim()
}

async function writeLicenses(runtimeRoot, nodeRoot, packages) {
  const sections = []
  const inputs = [['Node.js', join(nodeRoot, 'LICENSE')]]
  for (const packageName of packages) {
    inputs.push([packageName, join(packageDirectory(packageName), 'LICENSE')])
  }
  for (const [name, path] of inputs) {
    sections.push(`===== ${name} =====\n${(await readFile(path, 'utf8')).trim()}\n`)
  }
  await writeFile(join(runtimeRoot, 'THIRD_PARTY_LICENSES.txt'), `${sections.join('\n')}\n`, {
    mode: 0o644
  })
  await chmod(join(runtimeRoot, 'THIRD_PARTY_LICENSES.txt'), 0o644)
}

function assertPortableRuntimePath(path) {
  const segments = path.split('/')
  if (
    !PORTABLE_PATH.test(path) ||
    Buffer.byteLength(path) > MAX_PATH_BYTES ||
    segments.length > MAX_PATH_DEPTH
  ) {
    throw new Error(`Runtime tree contains non-portable path: ${path}`)
  }
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      WINDOWS_DEVICE_NAME.test(segment)
    ) {
      throw new Error(`Runtime tree contains non-portable path segment: ${path}`)
    }
  }
}

async function collectEntries(runtimeRoot) {
  const entries = []
  const folded = new Set()
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const child of children) {
      const absolutePath = join(directory, child.name)
      const path = relative(runtimeRoot, absolutePath).split(sep).join('/')
      assertPortableRuntimePath(path)
      const foldedPath = path.toLowerCase()
      if (folded.has(foldedPath)) {
        throw new Error(`Runtime tree contains a case-fold collision: ${path}`)
      }
      folded.add(foldedPath)
      if (child.isDirectory()) {
        await chmod(absolutePath, 0o755)
        entries.push({ path, type: 'directory', mode: 0o755 })
        await visit(absolutePath)
      } else if (child.isFile()) {
        const metadata = await stat(absolutePath)
        if (metadata.size > MAX_FILE_BYTES) {
          throw new Error(`Runtime file exceeds size limit: ${path}`)
        }
        const role = sshRelayRuntimeFileRole(path)
        // Why: NTFS has no POSIX execute bits; ZIP metadata carries the canonical runtime mode.
        const mode =
          process.platform === 'win32' &&
          ['node', 'node-pty-native', 'parcel-watcher-native', 'native-runtime'].includes(role)
            ? 0o755
            : process.platform === 'win32'
              ? 0o644
              : metadata.mode & 0o777
        if (mode !== 0o644 && mode !== 0o755) {
          throw new Error(`Runtime file has a non-canonical mode: ${path}`)
        }
        const bytes = await readFile(absolutePath)
        entries.push({
          path,
          type: 'file',
          role,
          size: bytes.length,
          mode,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
        })
      } else {
        throw new Error(`Runtime tree contains a prohibited special entry: ${path}`)
      }
    }
  }
  await visit(runtimeRoot)
  const files = entries.filter((entry) => entry.type === 'file')
  const expandedSize = files.reduce((total, file) => total + file.size, 0)
  if (files.length > MAX_FILES || expandedSize > MAX_EXPANDED_BYTES) {
    throw new Error('Runtime tree exceeds the manifest file-count or expanded-size limit')
  }
  return { entries, fileCount: files.length, expandedSize }
}

export async function assembleSshRelayRuntimeTree({
  tuple,
  nodeRoot,
  nodePtyBuildDirectory,
  relayDirectory,
  runtimeRoot,
  nodeVersion
}) {
  const compatibility = sshRelayRuntimeCompatibility[tuple]
  if (!compatibility) {
    throw new Error(`Runtime tree assembly is not implemented for ${tuple}`)
  }
  await mkdir(runtimeRoot)
  const nodeName = tuple.startsWith('win32-') ? 'node.exe' : 'node'
  const nodeSource = tuple.startsWith('win32-')
    ? join(nodeRoot, nodeName)
    : join(nodeRoot, 'bin', nodeName)
  await copyNormalized(join(nodeSource), join(runtimeRoot, 'bin', nodeName), 0o755)
  const version = await relayBuildVersion(relayDirectory)
  await Promise.all([
    copyNormalized(join(relayDirectory, 'relay.js'), join(runtimeRoot, 'relay.js')),
    copyNormalized(join(relayDirectory, 'relay-watcher.js'), join(runtimeRoot, 'relay-watcher.js')),
    copyNormalized(join(relayDirectory, '.version'), join(runtimeRoot, '.version'))
  ])
  await copyNodePty(nodePtyBuildDirectory, runtimeRoot, tuple)
  const watcherPackage = await copyParcelWatcher(runtimeRoot, tuple)
  const licensePackages = [
    'node-pty',
    '@parcel/watcher',
    watcherPackage,
    'detect-libc',
    'is-glob',
    'is-extglob',
    'picomatch'
  ]
  await writeLicenses(runtimeRoot, nodeRoot, licensePackages)
  await writeJson(join(runtimeRoot, 'runtime-metadata.json'), {
    schemaVersion: 1,
    tuple,
    nodeVersion,
    relayBuildVersion: version,
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' }
  })

  const tree = await collectEntries(runtimeRoot)
  const os = tuple.startsWith('linux-') ? 'linux' : tuple.startsWith('darwin-') ? 'darwin' : 'win32'
  const architecture = tuple.includes('arm64') ? 'arm64' : 'x64'
  const identity = {
    tupleId: tuple,
    os,
    architecture,
    compatibility,
    nodeVersion,
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries: tree.entries
  }
  await verifySshRelayRuntimeClosure(runtimeRoot, identity)
  return { ...identity, contentId: computeSshRelayRuntimeContentId(identity), ...tree }
}
