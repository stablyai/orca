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
const { PE_MACHINE, readPeMachine } = require('./scripts/windows-pe-machine.cjs')
const { adoptPackagedNativeBuildEntries } = require('./packaged-native-build-entries.cjs')
const { runtimePackageExcludeFilter } = require('./packaged-windows-only-runtime-files.cjs')
const {
  NATIVE_BUILD_PACKAGES,
  TRANSIENT_NATIVE_BUILD_ENTRY_FILTER
} = require('./scripts/native-build-entry.cjs')

const projectDir = resolve(__dirname, '..')
const requireFromProject = createRequire(join(projectDir, 'package.json'))

const PACKAGED_RUNTIME_PACKAGE_ROOTS = [
  '@anthropic-ai/claude-agent-sdk',
  '@linear/sdk',
  '@orca/process-host',
  '@parcel/watcher',
  'electron-updater',
  'i18next',
  'jsonc-parser',
  'node-pty',
  'posthog-node',
  'proper-lockfile',
  'qrcode',
  'smol-toml',
  'ssh2',
  'tweetnacl',
  'ws',
  'yaml',
  'zod'
]
// serve-sim drives iOS Simulator; its Mach-O addon fails Windows PE signing.
const DARWIN_PACKAGED_RUNTIME_PACKAGE_ROOTS = ['serve-sim']
/** The compiled binary each workspace Windows addon loads, relative to its package. */
const WORKSPACE_WINDOWS_ADDON_BINARIES = [
  ['@orca/windows-registry', 'build/Release/orca_windows_registry.node'],
  ['@orca/windows-security', 'build/Release/orca_windows_security.node']
]
const WINDOWS_PACKAGED_RUNTIME_PACKAGE_ROOTS = [
  '@vscode/windows-process-tree',
  '@orca/windows-registry',
  '@orca/windows-security'
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
const PACKAGED_MAIN_REQUIRED_FILES = [
  'out/main/index.js',
  'out/main/agent-hooks/managed-agent-hook-controls.js'
]
const PACKAGED_MAIN_SOURCE_RE = /^out\/main\/.+\.js$/
const TYPE_DECLARATION_ARTIFACT_RE = /\.d\.(?:c|m)?ts(?:\.map)?$/
const JS_SOURCE_MAP_ARTIFACT_RE = /\.(?:c|m)?js\.map$/
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
  // serve-sim exports middleware/state but no root; resolve package.json directly instead of require.resolve("serve-sim").
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
      // Allow only known omitted serve-sim inspect-webkit dependency; other broken closures still fail packaging.
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
    ...(electronPlatformName === 'darwin' ? DARWIN_PACKAGED_RUNTIME_PACKAGE_ROOTS : []),
    ...(electronPlatformName === 'win32' ? WINDOWS_PACKAGED_RUNTIME_PACKAGE_ROOTS : [])
  ]
  for (const packageName of packageRoots) {
    visit(packageName)
  }

  // @parcel/watcher loads native optional subpackages absent from dependency traversal; include installed target variants, then afterPack prunes foreign binaries.
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
  return collectPackagedRuntimePackages(electronPlatformName).map(([packageName, packageDir]) => {
    const filter = [
      ...(packageName === '@orca/process-host' ? ['package.json', 'dist/**/*'] : []),
      // Why: another worktree can rename these away mid-copy, failing the walk with ENOENT.
      ...(NATIVE_BUILD_PACKAGES[packageName] ? TRANSIENT_NATIVE_BUILD_ENTRY_FILTER : []),
      ...runtimePackageExcludeFilter(packageName, electronPlatformName)
    ]
    return {
      from: packageDir,
      to: join('node_modules', ...packageName.split('/')),
      ...(filter.length > 0 ? { filter } : {})
    }
  })
}

function listProcessHostModules(directory, extension, prefix = '') {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${prefix}${entry.name}`
    if (entry.isDirectory()) {
      return entry.name === '__fixtures__'
        ? []
        : listProcessHostModules(join(directory, entry.name), extension, `${relativePath}/`)
    }
    return entry.name.endsWith(extension) && !entry.name.endsWith(`.test${extension}`)
      ? [relativePath.slice(0, -extension.length)]
      : []
  })
}

// Resource filters copy dist as-is; assert complete/current process-host emission matching package tsconfig.
function assertProcessHostOutputBuilt(packageDir = readPackage('@orca/process-host').packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const publicTargets = [
    manifest.main,
    ...Object.values(manifest.exports ?? {}).map((target) =>
      typeof target === 'string' ? target : target?.default
    )
  ].filter((target) => typeof target === 'string')
  const sources = listProcessHostModules(join(packageDir, 'src'), '.ts')
  const sourceSet = new Set(sources)
  const missing = [
    ...new Set([...publicTargets, ...sources.map((module) => `./dist/${module}.js`)])
  ].filter((target) => !existsSync(join(packageDir, target)))
  const stale = listProcessHostModules(join(packageDir, 'dist'), '.js')
    .filter((module) => !sourceSet.has(module))
    .map((module) => `./dist/${module}.js`)
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `@orca/process-host output in ${packageDir} does not match its source ` +
        `(missing: ${missing.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'}). ` +
        'Run `pnpm build:packages` before packaging.'
    )
  }
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

  const entries = asar.listPackage(asarPath)
  for (const file of PACKAGED_MAIN_REQUIRED_FILES) {
    if (!findAsarEntry(entries, file)) {
      throw new Error(`Packaged main file ${file} was not found in ${asarPath}`)
    }
  }

  const missing = new Set()
  // Scan every emitted main chunk: shared bare imports can move out of entry files during bundling.
  for (const entry of entries) {
    if (!PACKAGED_MAIN_SOURCE_RE.test(normalizeAsarEntryPath(entry))) {
      continue
    }

    // Why: @electron/asar lists entries with host separators; Windows returns
    // backslashes, and extractFile expects that same host-style path.
    const internalPath = entry.replace(/^[\\/]+/, '')
    const source = asar.extractFile(asarPath, internalPath).toString('utf8')
    // Exclude member require/import calls but admit spread operands; missing a real import blinds the guard.
    // Known limit: embedded source-string specifiers count too (ssh-relay-deploy’s node-pty); distinguishing them needs a parser.
    for (const match of source.matchAll(
      /(?:(?<![.\w])|(?<=\.\.\.))(?:require|import)\s*\(\s*(["'`])([^"'`$]+)\1\s*\)/g
    )) {
      const specifier = match[2]
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

/** Whether node-pty's source build holds a conpty.node the `electronArch` slice could load. */
function conptyTargetsArch(nodePtyDir, electronArch) {
  const releaseAddon = join(nodePtyDir, 'build', 'Release', 'conpty.node')
  if (!existsSync(releaseAddon)) {
    return false
  }
  // Null (not a PE) counts as unloadable, so a truncated or quarantined build keeps the fallback.
  return readPeMachine(releaseAddon) === PE_MACHINE[normalizeNodePtyWindowsArch(electronArch)]
}

function prunePackagedNodePty(resourcesDir, electronPlatformName, electronArch) {
  const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
  if (!existsSync(nodePtyDir)) {
    return
  }

  // Remove only conpty.node/pdb fallbacks when PE machine proves source addon matches target, preventing silent fallback to unpatched teardown.
  // Keep other prebuilds: source builds omit console-list/winpty binaries, needed for membership probing and Windows <18309.
  // Host/target arch equality is insufficient: foreign or cross-built build/Release contents can differ from host architecture.
  if (electronPlatformName === 'win32' && conptyTargetsArch(nodePtyDir, electronArch)) {
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

  // install:release fetches all CPUs; keep watcher core and only this target’s native variants.
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

// Declarations are compile-only; dependency maps embed unused sources (megabytes for Linear). Orca main maps ship separately.
function isPrunableTypeOrSourceMapArtifact(filename) {
  return TYPE_DECLARATION_ARTIFACT_RE.test(filename) || JS_SOURCE_MAP_ARTIFACT_RE.test(filename)
}

// File-deletion passes commute; one traversal avoids seconds of redundant walks.
function prunePackagedRuntimeTypeAndSourceMapArtifacts(resourcesDir) {
  const nodeModulesDir = join(resourcesDir, 'node_modules')
  if (!existsSync(nodeModulesDir)) {
    return
  }
  pruneMatchingFiles(nodeModulesDir, isPrunableTypeOrSourceMapArtifact)
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

// Fail missing target natives: electron-builder only warns for absent extraResources and could ship host-only installs as foreign slices.
function assertPackagedNativeVariantsInstalled(electronPlatformName, electronArch) {
  const architecture = normalizeElectronArchitecture(electronArch)
  const nodeModulesDir = join(projectDir, 'node_modules')
  const isInstalled = (name) => existsSync(join(nodeModulesDir, name, 'package.json'))
  const missing = []

  const rootOptionalDependencies =
    JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).optionalDependencies ?? {}
  // Why win32 is always x64: winSpeechNativeResource packages sherpa-onnx-win-x64 for every
  // Windows target (there is no sherpa-onnx-win-arm64; it runs under emulation).
  const sherpaName =
    electronPlatformName === 'win32'
      ? 'sherpa-onnx-win-x64'
      : `sherpa-onnx-${electronPlatformName}-${architecture}`
  if (sherpaName in rootOptionalDependencies && !isInstalled(sherpaName)) {
    missing.push(sherpaName)
  }

  // Why prefix, not equality: linux variants carry a libc suffix (watcher-linux-x64-glibc),
  // mirroring what prunePackagedParcelWatcher keeps.
  const watcherPrefix = `watcher-${electronPlatformName}-${architecture}`
  const parcelDir = join(nodeModulesDir, '@parcel')
  if (isInstalled('@parcel/watcher')) {
    const watcherOptionalDependencies = Object.keys(
      JSON.parse(readFileSync(join(parcelDir, 'watcher', 'package.json'), 'utf8'))
        .optionalDependencies ?? {}
    )
    const expectedVariants = watcherOptionalDependencies.filter((name) =>
      name.startsWith(`@parcel/${watcherPrefix}`)
    )
    // Why not withFileTypes: pnpm links the variants, so isDirectory() is false for them.
    const hasVariant = readdirSync(parcelDir).some(
      (name) => name.startsWith(watcherPrefix) && isInstalled(`@parcel/${name}`)
    )
    if (expectedVariants.length > 0 && !hasVariant) {
      missing.push(...expectedVariants)
    }
  }

  // Why one package: @vscode/windows-process-tree is the only os: win32 npm addon;
  // the @orca/windows-* addons are workspace links present on every host, so their presence proves nothing.
  const missingWindowsAddons = []
  if (electronPlatformName === 'win32' && !isInstalled('@vscode/windows-process-tree')) {
    missingWindowsAddons.push('@vscode/windows-process-tree')
  }
  // Check actual target binary, not universal workspace link, or packaged secure-file/orcad failures appear only at runtime.
  if (electronPlatformName === 'win32') {
    for (const [name, binary] of WORKSPACE_WINDOWS_ADDON_BINARIES) {
      const addon = join(nodeModulesDir, name, binary)
      if (!existsSync(addon) || readPeMachine(addon) !== PE_MACHINE[architecture]) {
        missingWindowsAddons.push(`${name} (${binary} for ${architecture})`)
      }
    }
  }

  if (missing.length === 0 && missingWindowsAddons.length === 0) {
    return
  }
  // install:release widens CPUs only; non-Windows hosts cannot supply the os:win32 addon, which Windows rebuild compiles.
  const remedies = []
  if (missing.length > 0) {
    remedies.push('Run pnpm install:release to install another architecture.')
  }
  if (missingWindowsAddons.length > 0) {
    remedies.push(
      'Windows packaging requires a Windows host: the Windows addons are installed only where ' +
        'os: win32 matches and compiled only by the Windows-only rebuild.'
    )
  }
  throw new Error(
    `Packaging ${electronPlatformName}/${architecture} requires native variants that are not installed: ` +
      `${[...new Set([...missing, ...missingWindowsAddons])].sort().join(', ')}. ${remedies.join(' ')}`
  )
}

function prunePackagedRuntimeNodeModules(resourcesDir, electronPlatformName, electronArch) {
  const architecture = normalizeElectronArchitecture(electronArch)
  // Before the node-pty prune, which judges build/Release.
  adoptPackagedNativeBuildEntries(resourcesDir, electronPlatformName, architecture)
  prunePackagedNodePty(resourcesDir, electronPlatformName, architecture)
  prunePackagedParcelWatcher(resourcesDir, electronPlatformName, architecture)
  // Why before the filename walk: zod/src is deleted wholesale, so walking it first is wasted work.
  prunePackagedZodSources(resourcesDir)
  prunePackagedRuntimeTypeAndSourceMapArtifacts(resourcesDir)
  prunePackagedSherpaOnnx(resourcesDir, electronPlatformName)
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
  WINDOWS_PACKAGED_RUNTIME_PACKAGE_ROOTS,
  assertPackagedNativeVariantsInstalled,
  assertProcessHostOutputBuilt,
  createPackagedRuntimeNodeModuleResources,
  findAsarEntry,
  isPackagedExternalSpecifier,
  normalizeNodePtyWindowsArch,
  packageNameFromSpecifier,
  prunePackagedNodePty,
  prunePackagedParcelWatcher,
  prunePackagedRuntimeNodeModules,
  prunePackagedRuntimeTypeAndSourceMapArtifacts,
  prunePackagedSherpaOnnx,
  prunePackagedZodSources,
  verifyPackagedMainRuntimeDeps
}
