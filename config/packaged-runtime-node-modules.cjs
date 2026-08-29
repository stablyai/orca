const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync
} = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { builtinModules, createRequire } = require('node:module')

const projectDir = resolve(__dirname, '..')
const requireFromProject = createRequire(join(projectDir, 'package.json'))

const PACKAGED_RUNTIME_PACKAGE_ROOTS = [
  '@electron-toolkit/utils',
  '@linear/sdk',
  '@parcel/watcher',
  'electron-updater',
  'i18next',
  'jsonc-parser',
  'node-pty',
  'posthog-node',
  // serve-sim (for CLI JS entry + closure + state/middleware + to make packaged require('serve-sim') + its internal relatives work; mirrors other runtime JS like ws/yaml/zod. Natives/dylibs still via extraResources + the node_modules/serve-sim copy in resources from builder. Client if added too.
  'serve-sim',
  'qrcode',
  'ssh2',
  'tweetnacl',
  'ws',
  'yaml',
  'zod'
]
const WINDOWS_PACKAGED_RUNTIME_PACKAGE_ROOTS = [
  '@vscode/windows-process-tree',
  'windows-native-registry'
]

const NODE_PTY_PREBUILD_PREFIX_BY_PLATFORM = {
  darwin: 'darwin-',
  linux: 'linux-',
  win32: 'win32-'
}
const NODE_PTY_CONPTY_RUNTIME_FILES = ['conpty.dll', 'OpenConsole.exe']
const PARCEL_WATCHER_PLATFORM_PREFIX_BY_PLATFORM = {
  darwin: 'watcher-darwin',
  linux: 'watcher-linux',
  win32: 'watcher-win32'
}
const ELECTRON_ARCHITECTURE_BY_ENUM = {
  0: 'ia32',
  1: 'x64',
  2: 'arm',
  3: 'arm64',
  4: 'universal'
}
const PACKAGED_NATIVE_ARCHITECTURES = new Set(['ia32', 'x64', 'arm', 'arm64'])
const TYPE_DECLARATION_ARTIFACT_RE = /\.d\.(?:c|m)?ts(?:\.map)?$/
const VERSIONED_ONNXRUNTIME_DYLIB_RE = /^libonnxruntime\.\d[\d.]*\.dylib$/

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
])

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return scope && name ? `${scope}/${name}` : specifier
  }
  return specifier.split('/')[0]
}

function isPackagedExternalSpecifier(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    specifier !== 'electron' &&
    !NODE_BUILTINS.has(specifier)
  )
}

function resolvePackageJsonPath(packageName, fromDir = projectDir) {
  const nested = join(fromDir, 'node_modules', packageName, 'package.json')
  if (existsSync(nested)) {
    return nested
  }
  // Why: published serve-sim has no "." export (only ./middleware and ./state), so
  // require.resolve('serve-sim') fails even though the package is present for bridge exec.
  if (packageName === 'serve-sim') {
    const direct = join(projectDir, 'node_modules', 'serve-sim', 'package.json')
    if (existsSync(direct)) {
      return direct
    }
  }
  try {
    return requireFromProject.resolve(`${packageName}/package.json`, { paths: [fromDir] })
  } catch {
    let entryPath
    try {
      entryPath = requireFromProject.resolve(packageName, { paths: [fromDir] })
    } catch {
      throw new Error(`Could not resolve package ${packageName} from ${fromDir}`)
    }
    let dir = dirname(entryPath)
    while (dir !== dirname(dir)) {
      const packageJsonPath = join(dir, 'package.json')
      if (existsSync(packageJsonPath)) {
        return packageJsonPath
      }
      dir = dirname(dir)
    }
    throw new Error(`Could not find package.json for ${packageName}`)
  }
}

function readPackage(packageName, fromDir = projectDir) {
  const packageJsonPath = resolvePackageJsonPath(packageName, fromDir)
  const packageDir = realpathSync(dirname(packageJsonPath))
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  return {
    name: packageJson.name ?? packageName,
    packageDir,
    dependencies: Object.keys(packageJson.dependencies ?? {})
  }
}

function isKnownOmittedServeSimDependency(packageName, fromDir) {
  if (packageName !== 'inspect-webkit') {
    return false
  }
  const serveSimPackageJsonPath = join(projectDir, 'node_modules', 'serve-sim', 'package.json')
  if (!existsSync(serveSimPackageJsonPath)) {
    return false
  }
  try {
    return realpathSync(fromDir) === realpathSync(dirname(serveSimPackageJsonPath))
  } catch {
    return false
  }
}

function collectPackagedRuntimePackages(electronPlatformName = process.platform) {
  const packages = new Map()
  const visit = (packageName, fromDir = projectDir) => {
    if (packageName === 'electron' || packages.has(packageName)) {
      return
    }

    let packageInfo
    try {
      packageInfo = readPackage(packageName, fromDir)
    } catch (error) {
      // Why: serve-sim declares inspect-webkit, but current installs omit it.
      // Keep that escape hatch narrow so broken packages still fail packaging.
      if (isKnownOmittedServeSimDependency(packageName, fromDir)) {
        return
      }
      throw error
    }
    if (packages.has(packageInfo.name)) {
      return
    }
    packages.set(packageInfo.name, packageInfo.packageDir)

    for (const dependencyName of packageInfo.dependencies) {
      visit(dependencyName, packageInfo.packageDir)
    }
  }

  // Why: cross-builds must select native dependencies from the artifact target, not the build host.
  const packageRoots = [
    ...PACKAGED_RUNTIME_PACKAGE_ROOTS,
    ...(electronPlatformName === 'win32' ? WINDOWS_PACKAGED_RUNTIME_PACKAGE_ROOTS : [])
  ]
  for (const packageName of packageRoots) {
    visit(packageName)
  }

  // Why: @parcel/watcher loads its native .node addon from a platform-specific
  // optionalDependency (e.g. @parcel/watcher-linux-x64-glibc) that the
  // dependencies graph above never reaches. Include the ones installed for the
  // build's supported architectures; afterPack pruning trims non-target
  // platform/architecture variants. Without this the packaged main bundle's import of
  // '@parcel/watcher' resolves at runtime but throws loading its binary.
  const parcelWatcherDir = packages.get('@parcel/watcher')
  if (parcelWatcherDir) {
    const parcelWatcherPackage = JSON.parse(
      readFileSync(join(parcelWatcherDir, 'package.json'), 'utf8')
    )
    for (const optionalName of Object.keys(parcelWatcherPackage.optionalDependencies ?? {})) {
      try {
        visit(optionalName)
      } catch {
        // Optional platform subpackage is not installed for this build; skip it.
      }
    }
  }

  return [...packages.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function createPackagedRuntimeNodeModuleResources(electronPlatformName = process.platform) {
  return collectPackagedRuntimePackages(electronPlatformName).map(([packageName, packageDir]) => ({
    from: packageDir,
    to: join('node_modules', ...packageName.split('/'))
  }))
}

function normalizeAsarEntryPath(entry) {
  return entry.replace(/\\/g, '/').replace(/^\/+/, '')
}

function findAsarEntry(entries, expectedPath) {
  return entries.find((entry) => normalizeAsarEntryPath(entry) === expectedPath)
}

function verifyPackagedMainRuntimeDeps(resourcesDir, asar = require('@electron/asar')) {
  const asarPath = join(resourcesDir, 'app.asar')
  if (!existsSync(asarPath)) {
    return
  }

  const mainFiles = ['out/main/index.js', 'out/main/agent-hooks/managed-agent-hook-controls.js']
  const entries = asar.listPackage(asarPath)
  const missing = new Set()

  for (const file of mainFiles) {
    const entry = findAsarEntry(entries, file)
    if (!entry) {
      throw new Error(`Packaged main file ${file} was not found in ${asarPath}`)
    }

    // Why: @electron/asar lists entries with host separators; Windows returns
    // backslashes, and extractFile expects that same host-style path.
    const internalPath = entry.replace(/^[\\/]+/, '')
    const source = asar.extractFile(asarPath, internalPath).toString('utf8')
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const specifier = match[1]
      if (!isPackagedExternalSpecifier(specifier)) {
        continue
      }
      const packageName = packageNameFromSpecifier(specifier)
      if (!existsSync(join(resourcesDir, 'node_modules', ...packageName.split('/')))) {
        missing.add(packageName)
      }
    }
  }

  if (missing.size > 0) {
    throw new Error(
      `Packaged main bundle has bare runtime imports without copied node_modules: ${[
        ...missing
      ].join(', ')}`
    )
  }
}

function normalizeNodePtyWindowsArch(electronArch) {
  const architecture = normalizeElectronArchitecture(electronArch)
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new Error(`Unsupported packaged node-pty Windows architecture: ${architecture}`)
  }
  return architecture
}

function normalizeElectronArchitecture(electronArch) {
  const architecture =
    typeof electronArch === 'number'
      ? ELECTRON_ARCHITECTURE_BY_ENUM[electronArch]
      : electronArch === 'armv7l'
        ? 'arm'
        : electronArch
  if (!PACKAGED_NATIVE_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported packaged runtime architecture: ${String(electronArch)}`)
  }
  return architecture
}

function pruneNodePtyNativeDirectories(directory, platformPrefix, electronArch, allowsSuffix) {
  if (!existsSync(directory)) {
    return
  }
  const architecture = normalizeElectronArchitecture(electronArch)
  const targetPrefix = `${platformPrefix}${architecture}`
  const platformPrefixes = Object.values(NODE_PTY_PREBUILD_PREFIX_BY_PLATFORM)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !platformPrefixes.some((prefix) => entry.name.startsWith(prefix))) {
      continue
    }
    const matchesTarget =
      entry.name.startsWith(platformPrefix) &&
      (entry.name === targetPrefix || (allowsSuffix && entry.name.startsWith(`${targetPrefix}-`)))
    if (!matchesTarget) {
      rmSync(join(directory, entry.name), { recursive: true, force: true })
    }
  }
}

function findNodePtyConptySourceDir(nodePtyDir, windowsArch) {
  const conptyRoot = join(nodePtyDir, 'third_party', 'conpty')
  if (!existsSync(conptyRoot)) {
    throw new Error(`Packaged node-pty is missing ${conptyRoot}`)
  }
  for (const entry of readdirSync(conptyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const sourceDir = join(conptyRoot, entry.name, `win10-${windowsArch}`)
    if (existsSync(sourceDir)) {
      return sourceDir
    }
  }
  throw new Error(`Packaged node-pty has no ConPTY payload for win10-${windowsArch}`)
}

function ensurePackagedNodePtyConptyRuntime(nodePtyDir, electronArch) {
  const releaseDir = join(nodePtyDir, 'build', 'Release')
  if (!existsSync(join(releaseDir, 'conpty.node'))) {
    return
  }

  const runtimeDir = join(releaseDir, 'conpty')
  const missingRuntimeFiles = NODE_PTY_CONPTY_RUNTIME_FILES.filter(
    (filename) => !existsSync(join(runtimeDir, filename))
  )
  if (missingRuntimeFiles.length === 0) {
    return
  }

  const windowsArch = normalizeNodePtyWindowsArch(electronArch)
  const sourceDir = findNodePtyConptySourceDir(nodePtyDir, windowsArch)
  mkdirSync(runtimeDir, { recursive: true })
  for (const filename of missingRuntimeFiles) {
    const sourceFile = join(sourceDir, filename)
    if (!existsSync(sourceFile)) {
      throw new Error(`Packaged node-pty is missing ${sourceFile}`)
    }
    // Why: node-pty's Windows addon loads conpty.dll relative to conpty.node,
    // but its install script can run before electron-builder gathers resources.
    copyFileSync(sourceFile, join(runtimeDir, filename))
  }
}

function prunePackagedNodePty(resourcesDir, electronPlatformName, electronArch) {
  const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
  if (!existsSync(nodePtyDir)) {
    return
  }

  // Why delete only conpty.node: node-pty's loader tries build/Release, then
  // build/Debug, then prebuilds/<platform>-<arch>, swallowing every failure in
  // between. Only the source build carries Orca's job-object exports, so an ABI
  // mismatch or an AV quarantine of build/Release/conpty.node would silently
  // fall through to the UNPATCHED prebuild -- teardown back to guessing by PID
  // ancestry, with no error anywhere.
  //
  // Why NOT the whole prebuilds/ tree: Orca's own patch deletes the
  // `conpty_console_list` and winpty `pty` gyp targets, so a Windows source
  // build emits conpty.node and nothing else. conpty_console_list.node,
  // pty.node, winpty.dll and winpty-agent.exe exist ONLY here. Removing them
  // silently kills console-membership probing (the forked agent throws at
  // require, and its caller resolves null with silent: true), and removes the
  // winpty backend that node-pty still selects below Windows build 18309.
  //
  // Why the arch check: a cross-arch package copies the host's build/Release,
  // so its mere presence does not mean it matches electronArch -- deleting the
  // target-arch prebuild would then remove the only loadable binary.
  if (
    electronPlatformName === 'win32' &&
    electronArch === process.arch &&
    existsSync(join(nodePtyDir, 'build', 'Release', 'conpty.node'))
  ) {
    const prebuildDir = join(nodePtyDir, 'prebuilds', `win32-${electronArch}`)
    for (const staleFallback of ['conpty.node', 'conpty.pdb']) {
      rmSync(join(prebuildDir, staleFallback), { force: true })
    }
  }

  const allowedPrebuildPrefix = NODE_PTY_PREBUILD_PREFIX_BY_PLATFORM[electronPlatformName]
  if (allowedPrebuildPrefix) {
    pruneNodePtyNativeDirectories(
      join(nodePtyDir, 'prebuilds'),
      allowedPrebuildPrefix,
      electronArch,
      false
    )
    // Why: sequential cross-arch rebuilds accumulate ABI-tagged outputs here.
    pruneNodePtyNativeDirectories(
      join(nodePtyDir, 'bin'),
      allowedPrebuildPrefix,
      electronArch,
      true
    )
  }

  if (electronPlatformName === 'win32') {
    ensurePackagedNodePtyConptyRuntime(nodePtyDir, electronArch)
  } else {
    // Why: conpty is Windows-only and node-pty resolves runtime binaries from
    // build/Release or prebuilds/<platform>-<arch>, not third_party/conpty.
    rmSync(join(nodePtyDir, 'third_party', 'conpty'), { recursive: true, force: true })
    rmSync(join(nodePtyDir, 'deps', 'winpty'), { recursive: true, force: true })
  }
}

function prunePackagedParcelWatcher(resourcesDir, electronPlatformName, electronArch) {
  const parcelDir = join(resourcesDir, 'node_modules', '@parcel')
  if (!existsSync(parcelDir)) {
    return
  }

  // Why: we package every installed @parcel/watcher-<platform> optional
  // subpackage (supportedArchitectures fetches all), but each build only needs
  // its own platform/architecture binaries. Keep the core package and matching
  // native variants; drop the rest.
  const keepPrefix = PARCEL_WATCHER_PLATFORM_PREFIX_BY_PLATFORM[electronPlatformName]
  const architecture = normalizeElectronArchitecture(electronArch)
  const targetPrefix = keepPrefix ? `${keepPrefix}-${architecture}` : null
  for (const entry of readdirSync(parcelDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'watcher') {
      continue
    }
    // Why: only ever prune the watcher's own platform subpackages. Guards against
    // nuking an unrelated @parcel/* runtime dep if one is added to the roots later.
    if (!entry.name.startsWith('watcher-')) {
      continue
    }
    if (
      keepPrefix &&
      entry.name.startsWith(keepPrefix) &&
      (entry.name === targetPrefix || entry.name.startsWith(`${targetPrefix}-`))
    ) {
      continue
    }
    rmSync(join(parcelDir, entry.name), { recursive: true, force: true })
  }
}

function prunePackagedRuntimeTypeDeclarations(resourcesDir) {
  const nodeModulesDir = join(resourcesDir, 'node_modules')
  if (!existsSync(nodeModulesDir)) {
    return
  }
  pruneMatchingFiles(nodeModulesDir, (filename) => TYPE_DECLARATION_ARTIFACT_RE.test(filename))
}

function prunePackagedSherpaOnnx(resourcesDir, electronPlatformName) {
  if (electronPlatformName !== 'darwin') {
    return
  }
  const nodeModulesDir = join(resourcesDir, 'node_modules')
  if (!existsSync(nodeModulesDir)) {
    return
  }
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('sherpa-onnx-darwin-')) {
      continue
    }
    const packageDir = join(nodeModulesDir, entry.name)
    const packageEntries = readdirSync(packageDir)
    const hasVersionedOnnxRuntime = packageEntries.some((filename) =>
      VERSIONED_ONNXRUNTIME_DYLIB_RE.test(filename)
    )
    if (hasVersionedOnnxRuntime) {
      // Why: darwin sherpa-onnx binaries link to the versioned ONNX Runtime
      // install name; the unversioned dylib is a duplicate fallback copy.
      rmSync(join(packageDir, 'libonnxruntime.dylib'), { force: true })
    }
  }
}

function prunePackagedZodSources(resourcesDir) {
  // Why: Zod's src tree is TypeScript source only selected by the @zod/source
  // condition; packaged runtime import/require paths resolve to built JS.
  rmSync(join(resourcesDir, 'node_modules', 'zod', 'src'), { recursive: true, force: true })
}

function prunePackagedRuntimeNodeModules(resourcesDir, electronPlatformName, electronArch) {
  const architecture = normalizeElectronArchitecture(electronArch)
  prunePackagedNodePty(resourcesDir, electronPlatformName, architecture)
  prunePackagedParcelWatcher(resourcesDir, electronPlatformName, architecture)
  prunePackagedRuntimeTypeDeclarations(resourcesDir)
  prunePackagedSherpaOnnx(resourcesDir, electronPlatformName)
  prunePackagedZodSources(resourcesDir)
}

function pruneMatchingFiles(directory, shouldPrune) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      pruneMatchingFiles(entryPath, shouldPrune)
    } else if (entry.isFile() && shouldPrune(entry.name)) {
      rmSync(entryPath, { force: true })
    }
  }
}

module.exports = {
  PACKAGED_RUNTIME_PACKAGE_ROOTS,
  createPackagedRuntimeNodeModuleResources,
  findAsarEntry,
  isPackagedExternalSpecifier,
  packageNameFromSpecifier,
  prunePackagedNodePty,
  prunePackagedParcelWatcher,
  prunePackagedRuntimeNodeModules,
  prunePackagedSherpaOnnx,
  prunePackagedRuntimeTypeDeclarations,
  prunePackagedZodSources,
  verifyPackagedMainRuntimeDeps
}
