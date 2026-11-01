export function electronNativeProbeSource(
  moduleNames,
  requirePatchedNodePtySourceBuild,
  NODE_PTY_CONPTY_RUNTIME_FILES
) {
  return `
const { createRequire } = require('node:module')
const { existsSync } = require('node:fs')
const { resolve } = require('node:path')
const projectRequire = createRequire(resolve(process.cwd(), 'package.json'))
const { isSourceBuildDir, nodePtyNativeModuleName: getNodePtyNativeModuleName } = projectRequire(
  './config/scripts/native-build-entry.cjs'
)
const moduleNames = ${JSON.stringify(moduleNames)}
const requirePatchedNodePtySourceBuild = ${JSON.stringify(requirePatchedNodePtySourceBuild)}
const failures = []

for (const moduleName of moduleNames) {
  try {
    loadNativeModule(moduleName)
  } catch (error) {
    failures.push(moduleName + ': ' + formatError(error))
  }
}

if (failures.length > 0) {
  console.error(failures.join('\\n'))
  process.exit(1)
}

function loadNativeModule(moduleName) {
  if (moduleName === '@orca/history-filesystem') {
    projectRequire('./config/scripts/history-filesystem-probe.cjs').probeHistoryFilesystem(projectRequire(moduleName))
    return
  }
  if (moduleName === '@orca/windows-registry') {
    const registry = projectRequire(moduleName)
    // Why: the package defers loading its .node addon until the first registry call.
    registry.getRegistryKey(registry.HK.CU, 'Environment')
    return
  }
  if (moduleName === '@orca/windows-security') {
    const security = projectRequire(moduleName)
    if (!security.currentUserSid() || !security.hasNativeExport('isolatedSpawnBreaksAwayFromJob')) throw new Error('stale build without the newest export; rebuild it')
    return
  }
  if (moduleName === 'node-pty') {
    projectRequire('node-pty')
    const { assertNodePtyJobOwnership, nodePtyAddonPath } = projectRequire(
      './config/scripts/node-pty-job-ownership.cjs'
    )
    const { loadNativeModule } = projectRequire('node-pty/lib/utils')
    const nativeName = getNodePtyNativeModuleName()
    const native = loadNativeModule(nativeName)
    const addonPath = nodePtyAddonPath(
      projectRequire.resolve('node-pty/lib/utils'),
      native,
      nativeName
    )
    assertNodePtyWindowsConptyRuntime(native.dir, require('node:path').dirname(addonPath))
    assertNodePtyJobOwnership({ nativeName, native, addonPath })
    if (requirePatchedNodePtySourceBuild && !isSourceBuildDir(native.dir)) {
      throw new Error(
        'node-pty resolved to ' +
          native.dir +
          '; expected build/Release so Orca\\'s node-pty patch is active'
      )
    }
    return
  }
  if (moduleName === '@vscode/windows-process-tree') {
    // The tarball prebuilt loads under Electron too -- the addon is N-API, so
    // a bare require proves nothing about which source it was built from.
    const { assertWindowsProcessTreeCreationTime } = projectRequire(
      './config/scripts/windows-process-tree-creation-time.cjs'
    )
    assertWindowsProcessTreeCreationTime({ module: projectRequire(moduleName) })
    return
  }
  projectRequire(moduleName)
}

function assertNodePtyWindowsConptyRuntime(nativeDir, loadedDir) {
  if (process.platform !== 'win32' || !isSourceBuildDir(nativeDir)) {
    return
  }
  const runtimeDir = resolve(loadedDir, 'conpty')
  for (const filename of ${JSON.stringify(NODE_PTY_CONPTY_RUNTIME_FILES)}) {
    const runtimeFile = resolve(runtimeDir, filename)
    if (!existsSync(runtimeFile)) {
      throw new Error('node-pty ConPTY runtime file is missing: ' + runtimeFile)
    }
  }
}


function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
`
}
