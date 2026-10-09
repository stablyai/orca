// The signed `com.stablyai.orca` helper that runs the terminal daemon on the pinned Node.
// See docs/reference/macos-daemon-tcc-attribution.md.
const { spawnSync } = require('node:child_process')
const {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const MAC_TERMINAL_HOST_NAME = 'Orca Terminal Host'
const MAC_TERMINAL_HOST_EXECUTABLE = 'orca-terminal-host'
const macTerminalHostSignIgnore = [`/Contents/Helpers/${MAC_TERMINAL_HOST_NAME}\\.app(/|$)`]
const NODE_PTY_FILES = [
  'package.json',
  'lib',
  join('build', 'Release', 'pty.node'),
  join('build', 'Release', 'spawn-helper')
]
// A helper that claimed any of these could take `orca:` links or documents from Orca.app.
const FORBIDDEN_INFO_KEYS = [
  'CFBundleURLTypes',
  'CFBundleDocumentTypes',
  'UTExportedTypeDeclarations',
  'UTImportedTypeDeclarations',
  'NSServices'
]
const LIPO_ARCH_TO_NODE_ARCH = { x86_64: 'x64', arm64: 'arm64' }

function macTerminalHostPaths(appPath) {
  const bundle = join(appPath, 'Contents', 'Helpers', `${MAC_TERMINAL_HOST_NAME}.app`)
  const contents = join(bundle, 'Contents')
  const daemon = join(contents, 'Resources', 'daemon')
  const ptyRelease = join(daemon, 'node_modules', 'node-pty', 'build', 'Release')
  return {
    bundle,
    infoPlist: join(contents, 'Info.plist'),
    executable: join(contents, 'MacOS', MAC_TERMINAL_HOST_EXECUTABLE),
    icon: join(contents, 'Resources', 'icon.icns'),
    daemon,
    entry: join(daemon, 'out', 'main', 'daemon-entry.js'),
    outPackageJson: join(daemon, 'out', 'package.json'),
    nodePty: join(daemon, 'node_modules', 'node-pty'),
    ptyNode: join(ptyRelease, 'pty.node'),
    spawnHelper: join(ptyRelease, 'spawn-helper')
  }
}

function readPlist(path) {
  return JSON.parse(spawnChecked('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]).stdout)
}

function writePlist(path, value) {
  writeFileSync(path, JSON.stringify(value))
  spawnChecked('/usr/bin/plutil', ['-convert', 'xml1', path])
}

function spawnChecked(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(
      `[macos-terminal-host] ${program} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`
    )
  }
  return result
}

function buildMacTerminalHostInfo({ appInfo, usageDescriptions, minimumOs }) {
  return {
    ...usageDescriptions,
    CFBundleIdentifier: appInfo.CFBundleIdentifier,
    CFBundleName: 'Orca',
    CFBundleDisplayName: 'Orca',
    CFBundleExecutable: MAC_TERMINAL_HOST_EXECUTABLE,
    CFBundlePackageType: 'APPL',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleIconFile: 'icon.icns',
    // Lower than the app's so LaunchServices ranks the helper below Orca.app among duplicates.
    CFBundleVersion: '0',
    CFBundleShortVersionString: appInfo.CFBundleShortVersionString,
    LSMinimumSystemVersion: minimumOs,
    LSUIElement: true
  }
}

function findMacTerminalHostInfoProblems(info, { appId, usageDescriptions, minimumOs }) {
  const problems = []
  if (info.CFBundleIdentifier !== appId) {
    problems.push(`CFBundleIdentifier is ${info.CFBundleIdentifier}, expected ${appId}`)
  }
  for (const key of FORBIDDEN_INFO_KEYS) {
    if (Object.hasOwn(info, key)) {
      problems.push(`declares ${key}`)
    }
  }
  for (const [key, value] of Object.entries(usageDescriptions)) {
    if (JSON.stringify(info[key]) !== JSON.stringify(value)) {
      problems.push(`${key} differs from the app's`)
    }
  }
  if (info.LSMinimumSystemVersion !== minimumOs) {
    problems.push(`LSMinimumSystemVersion is ${info.LSMinimumSystemVersion}, expected ${minimumOs}`)
  }
  return problems
}

/** `otool -l` prints `minos 13.5` under the LC_BUILD_VERSION load command. */
function parseBuildVersionMinos(otoolOutput) {
  const lines = otoolOutput.split('\n')
  const command = lines.findIndex((line) => /cmd LC_BUILD_VERSION\s*$/.test(line))
  if (command === -1) {
    return null
  }
  for (const line of lines.slice(command + 1)) {
    if (/^\s*cmd /.test(line)) {
      return null
    }
    const match = /^\s*minos (\S+)/.exec(line)
    if (match) {
      return match[1]
    }
  }
  return null
}

function lipoArchsToNodeArchs(lipoOutput) {
  return lipoOutput
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((arch) => LIPO_ARCH_TO_NODE_ARCH[arch] ?? arch)
}

/** Copies the pinned Node, the daemon JS and this slice's node-pty into `Contents/Helpers`. */
function assembleMacTerminalHost({ appPath, nodeExecutable, iconPath, info }) {
  const resourcesDir = join(appPath, 'Contents', 'Resources')
  const daemonOut = join(resourcesDir, 'app.asar.unpacked', 'out')
  const nodePty = join(resourcesDir, 'node_modules', 'node-pty')
  for (const required of [join(daemonOut, 'main', 'daemon-entry.js'), nodePty, nodeExecutable]) {
    if (!existsSync(required)) {
      throw new Error(`[macos-terminal-host] missing ${required}`)
    }
  }
  const paths = macTerminalHostPaths(appPath)
  rmSync(paths.bundle, { recursive: true, force: true })
  mkdirSync(join(paths.bundle, 'Contents', 'MacOS'), { recursive: true })
  cpSync(nodeExecutable, paths.executable)
  chmodSync(paths.executable, 0o755)
  cpSync(iconPath, paths.icon)
  cpSync(join(daemonOut, 'main'), join(paths.daemon, 'out', 'main'), { recursive: true })
  // Pins out/ to CommonJS so a stray parent package.json cannot change the loader.
  cpSync(join(daemonOut, 'package.json'), paths.outPackageJson)
  for (const file of NODE_PTY_FILES) {
    cpSync(join(nodePty, file), join(paths.nodePty, file), { recursive: true })
  }
  chmodSync(paths.spawnHelper, 0o755)
  writePlist(paths.infoPlist, info)
  return paths
}

async function loadNodeRuntimePin() {
  return import(pathToFileURL(resolve(__dirname, '../../src/shared/node-runtime-pin.ts')).href)
}

async function pinnedDarwinNode(arch) {
  const { ensurePinnedNodeExecutable } = await import(
    pathToFileURL(resolve(__dirname, 'pinned-node-downloads.mjs')).href
  )
  return ensurePinnedNodeExecutable({ target: `darwin-${arch}` })
}

/**
 * Assembles and signs the helper inside-out. `signCode(path, { entitlements })` signs one path
 * with the build's helper identity and verifies it.
 */
async function buildMacTerminalHost({
  appPath,
  arch,
  iconPath,
  entitlementsPath,
  usageDescriptions,
  signCode
}) {
  const { NODE_RUNTIME_DARWIN_MINIMUM_OS } = await loadNodeRuntimePin()
  const paths = assembleMacTerminalHost({
    appPath,
    nodeExecutable: await pinnedDarwinNode(arch),
    iconPath,
    info: buildMacTerminalHostInfo({
      appInfo: readPlist(join(appPath, 'Contents', 'Info.plist')),
      usageDescriptions,
      minimumOs: NODE_RUNTIME_DARWIN_MINIMUM_OS
    })
  })
  await signCode(paths.ptyNode, {})
  await signCode(paths.spawnHelper, {})
  await signCode(paths.bundle, { entitlements: entitlementsPath })
  return paths
}

function readCodesignDetails(bundle) {
  const output = spawnChecked('/usr/bin/codesign', ['-dvv', bundle]).stderr
  const field = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(output)?.[1] ?? null
  return { identifier: field('Identifier'), teamId: field('TeamIdentifier') }
}

function hasAllowJitEntitlement(bundle) {
  const { stdout } = spawnChecked('/usr/bin/codesign', [
    '-d',
    '--entitlements',
    '-',
    '--xml',
    bundle
  ])
  return /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/.test(stdout)
}

/** Fails packaging on any layout, plist, OS floor, architecture or signature drift. */
async function verifyMacTerminalHost({ appPath, arch, usageDescriptions, expectedTeamId }) {
  const { NODE_RUNTIME_DARWIN_MINIMUM_OS: minimumOs } = await loadNodeRuntimePin()
  const paths = macTerminalHostPaths(appPath)
  const problems = []
  for (const key of ['executable', 'icon', 'entry', 'outPackageJson', 'ptyNode', 'spawnHelper']) {
    if (!existsSync(paths[key])) {
      problems.push(`missing ${paths[key]}`)
    }
  }
  if (problems.length === 0 && (statSync(paths.spawnHelper).mode & 0o111) === 0) {
    problems.push('spawn-helper is not executable')
  }
  if (problems.length > 0) {
    throw new Error(`[macos-terminal-host] ${problems.join('; ')}`)
  }
  const appId = readPlist(join(appPath, 'Contents', 'Info.plist')).CFBundleIdentifier
  problems.push(
    ...findMacTerminalHostInfoProblems(readPlist(paths.infoPlist), {
      appId,
      usageDescriptions,
      minimumOs
    })
  )
  const minos = parseBuildVersionMinos(
    spawnChecked('/usr/bin/otool', ['-l', paths.executable]).stdout
  )
  if (minos !== minimumOs) {
    problems.push(
      `the Node binary's minos is ${minos}, but NODE_RUNTIME_DARWIN_MINIMUM_OS is ${minimumOs}`
    )
  }
  for (const binary of [paths.executable, paths.ptyNode, paths.spawnHelper]) {
    const archs = lipoArchsToNodeArchs(spawnChecked('/usr/bin/lipo', ['-archs', binary]).stdout)
    if (archs.length !== 1 || archs[0] !== arch) {
      problems.push(`${binary} has architectures ${archs.join(',')}, expected ${arch}`)
    }
  }
  const { identifier, teamId } = readCodesignDetails(paths.bundle)
  if (identifier !== appId) {
    problems.push(`signed identifier is ${identifier}, expected ${appId}`)
  }
  if (expectedTeamId && teamId !== expectedTeamId) {
    problems.push(`signed team is ${teamId}, expected ${expectedTeamId}`)
  }
  if (!hasAllowJitEntitlement(paths.bundle)) {
    problems.push('the signature lacks the allow-jit entitlement Node needs')
  }
  // After the boot check, so a write into the bundle while it ran fails the build.
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', paths.bundle], {
    encoding: 'utf8'
  })
  if (verified.status !== 0) {
    problems.push(`codesign --verify --strict failed: ${verified.stderr.trim()}`)
  }
  if (problems.length > 0) {
    throw new Error(`[macos-terminal-host] ${problems.join('; ')}`)
  }
  console.log(`[macos-terminal-host] OK — ${paths.bundle} (${arch}, macOS ${minimumOs}+)`)
}

module.exports = {
  MAC_TERMINAL_HOST_NAME,
  assembleMacTerminalHost,
  buildMacTerminalHost,
  buildMacTerminalHostInfo,
  findMacTerminalHostInfoProblems,
  lipoArchsToNodeArchs,
  macTerminalHostPaths,
  macTerminalHostSignIgnore,
  parseBuildVersionMinos,
  verifyMacTerminalHost
}
