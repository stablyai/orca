import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceScriptPath = fileURLToPath(new URL('./ensure-native-runtime.mjs', import.meta.url))

// Why: the node-pty source-build tests never run on win32, so this is always foreign.
const FOREIGN_PREBUILD_TARGET = 'win32-x64'

// Why: writing into process.cwd() also asserts node-gyp runs inside the node-pty package.
const NODE_GYP_SHIM_SOURCE = `
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

appendFileSync(
  process.env.ORCA_NATIVE_TEST_LOG,
  \`node-gyp \${process.argv.slice(2).join(' ')} cwd=\${process.cwd()}\\n\`
)

const releaseDir = join(process.cwd(), 'build', 'Release')
mkdirSync(releaseDir, { recursive: true })
writeFileSync(join(releaseDir, 'pty.node'), '')
if (process.platform === 'darwin') {
  writeFileSync(join(releaseDir, 'spawn-helper'), '')
}
writeFileSync(process.env.ORCA_NATIVE_TEST_MARKER, 'rebuilt')
`

describe('ensure-native-runtime', () => {
  it('rechecks Node native modules in fresh child processes after rebuilding', () => {
    const projectDir = mkTempProject()

    try {
      const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
      const logPath = join(projectDir, 'native-runtime.log')
      const markerPath = join(projectDir, 'rebuilt.marker')
      const binDir = join(projectDir, 'bin')
      copyFileSync(sourceScriptPath, scriptPath)
      writeFakeNativeModules(projectDir)
      writeFakePnpm(binDir)

      const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
        cwd: projectDir,
        encoding: 'utf8',
        env: envWithPrependedPath(binDir, {
          ORCA_NATIVE_TEST_LOG: logPath,
          ORCA_NATIVE_TEST_MARKER: markerPath
        })
      })

      expect(result.status, result.stderr).toBe(0)
      const log = readFileSync(logPath, 'utf8')
      expect(log).toContain('pnpm rebuild node-pty\n')
      expect(log.split('\n').filter((line) => line.startsWith('node-pty child '))).toEqual([
        expect.stringMatching(/^node-pty child (?:conpty|pty) marker=false$/),
        expect.stringMatching(/^node-pty child (?:conpty|pty) marker=true$/)
      ])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rebuilds patched node-pty artifacts even when the Node load check passes',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        const binDir = join(projectDir, 'bin')
        copyFileSync(sourceScriptPath, scriptPath)
        writeLoadableNativeModules(projectDir)
        writeNodePtyPatchFile(projectDir)
        writeFakePnpm(binDir)
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envWithPrependedPath(binDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).toContain(
          'Patched node-pty build artifacts are missing; rebuilding native deps.'
        )
        const log = readFileSync(logPath, 'utf8')
        expect(log).toContain('node-gyp rebuild')
        expect(log).not.toContain('pnpm rebuild')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rebuilds when patched artifacts exist but node-pty resolves to prebuilds',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        const binDir = join(projectDir, 'bin')
        copyFileSync(sourceScriptPath, scriptPath)
        writeLoadableNativeModules(projectDir)
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)
        writeFakePnpm(binDir)
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envWithPrependedPath(binDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).toContain("expected build/Release so Orca's node-pty patch is active")
        const log = readFileSync(logPath, 'utf8')
        expect(log).toContain('node-gyp rebuild')
        expect(log).not.toContain('pnpm rebuild')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the fast path when the platform-specific patched artifacts exist',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        const binDir = join(projectDir, 'bin')
        copyFileSync(sourceScriptPath, scriptPath)
        writeLoadableNativeModules(projectDir, { nativeDir: '../build/Release/' })
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)
        writeFakePnpm(binDir)
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envWithPrependedPath(binDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).not.toContain('Patched node-pty build artifacts are missing')
        const log = readFileSync(logPath, 'utf8')
        expect(log).not.toContain('pnpm rebuild')
        expect(log).not.toContain('node-gyp rebuild')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'builds patched node-pty from source even though a shipped prebuild short-circuits its install script',
    () => {
      const projectDir = mkTempProject()

      try {
        const outcome = runAgainstUpstreamLikeNodePty(projectDir)

        expect(outcome.result.status, outcome.result.stderr).toBe(0)
        // Why: macOS resolves the temp dir through /private, so match the suffix.
        expect(outcome.log).toMatch(/^node-gyp rebuild cwd=.*[/\\]node_modules[/\\]node-pty$/m)
        expect(existsSync(join(nodePtyDirOf(projectDir), 'build', 'Release', 'pty.node'))).toBe(
          true
        )
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps other platforms prebuilds so supportedArchitectures packaging still works',
    () => {
      const projectDir = mkTempProject()

      try {
        const outcome = runAgainstUpstreamLikeNodePty(projectDir)

        expect(outcome.result.status, outcome.result.stderr).toBe(0)
        const prebuildsDir = join(nodePtyDirOf(projectDir), 'prebuilds')
        expect(existsSync(join(prebuildsDir, FOREIGN_PREBUILD_TARGET, 'pty.node'))).toBe(true)
        expect(existsSync(join(prebuildsDir, hostPrebuildTarget(), 'pty.node'))).toBe(true)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'builds through npm_config_node_gyp when the bundled node-gyp is unusable',
    () => {
      const projectDir = mkTempProject()

      try {
        const outcome = runAgainstUpstreamLikeNodePty(projectDir, {
          nodeGypOverridePath: join(projectDir, 'external-node-gyp.cjs')
        })

        expect(outcome.result.status, outcome.result.stderr).toBe(0)
        expect(existsSync(join(nodePtyDirOf(projectDir), 'build', 'Release', 'pty.node'))).toBe(
          true
        )
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )
})

function runAgainstUpstreamLikeNodePty(projectDir, { nodeGypOverridePath = null } = {}) {
  const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
  const logPath = join(projectDir, 'native-runtime.log')
  const binDir = join(projectDir, 'bin')

  copyFileSync(sourceScriptPath, scriptPath)
  writeUpstreamLikeNodePty(projectDir)
  writeNodePtyPatchFile(projectDir)
  writePnpmRunningInstallScripts(binDir)
  // Why: omitting the resolvable copy proves the override is what got used.
  if (nodeGypOverridePath) {
    writeFileSync(nodeGypOverridePath, NODE_GYP_SHIM_SOURCE)
  } else {
    writeFakeNodeGyp(projectDir)
  }

  const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: envWithPrependedPath(binDir, {
      ORCA_NATIVE_TEST_LOG: logPath,
      ORCA_NATIVE_TEST_MARKER: join(projectDir, 'rebuilt.marker'),
      ...(nodeGypOverridePath ? { npm_config_node_gyp: nodeGypOverridePath } : {})
    })
  })

  return { result, log: readFileSync(logPath, 'utf8') }
}

function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-native-runtime-'))
  mkdirSync(join(projectDir, 'config', 'scripts'), { recursive: true })
  return projectDir
}

function envWithPrependedPath(binDir, extraEnv) {
  const pathKey =
    process.platform === 'win32'
      ? (Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path')
      : 'PATH'
  const inherited = { ...process.env }
  // Why: CI exports npm_config_node_gyp job-wide, which would run the real
  // node-gyp against these fixtures instead of the shim.
  delete inherited.npm_config_node_gyp

  return {
    ...inherited,
    ...extraEnv,
    [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ''}`
  }
}

function writeFakeNativeModules(projectDir) {
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })

  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')

exports.loadNativeModule = function loadNativeModule(nativeName) {
  const markerExists = existsSync(process.env.ORCA_NATIVE_TEST_MARKER)
  appendFileSync(
    process.env.ORCA_NATIVE_TEST_LOG,
    \`node-pty \${process.argv.includes('--check-only') ? 'child' : 'parent'} \${nativeName} marker=\${markerExists}\\n\`
  )
  if (!markerExists) {
    throw new Error('ABI mismatch sentinel')
  }
}
`
  )
  writeFakeWindowsRegistry(projectDir)
}

function writeLoadableNativeModules(projectDir, { nativeDir = null } = {}) {
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })

  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')

exports.loadNativeModule = function loadNativeModule(nativeName) {
  const rebuilt = existsSync(process.env.ORCA_NATIVE_TEST_MARKER)
  const dir = ${JSON.stringify(nativeDir)} ??
    (rebuilt ? '../build/Release/' : '../prebuilds/' + process.platform + '-' + process.arch + '/')
  appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-pty load \${nativeName} dir=\${dir}\\n\`)
  return { dir, module: {} }
}
`
  )
  writeFakeWindowsRegistry(projectDir)
}

function writeFakeWindowsRegistry(projectDir) {
  if (process.platform !== 'win32') {
    return
  }
  const registryDir = join(projectDir, 'node_modules', 'windows-native-registry')
  mkdirSync(registryDir, { recursive: true })
  writeFileSync(
    join(registryDir, 'index.js'),
    'exports.HK = { CU: 0x80000001 }; exports.getRegistryKey = () => ({})\n'
  )
}

function writeNodePtyPatchFile(projectDir) {
  mkdirSync(join(projectDir, 'config', 'patches'), { recursive: true })
  writeFileSync(join(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch'), 'patch marker\n')
}

function writePatchedNodePtyBuildArtifacts(projectDir) {
  const buildDir = join(projectDir, 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(join(buildDir, 'pty.node'), '')
  if (process.platform === 'darwin') {
    writeFileSync(join(buildDir, 'spawn-helper'), '')
  }
}

function nodePtyDirOf(projectDir) {
  return join(projectDir, 'node_modules', 'node-pty')
}

function hostPrebuildTarget() {
  return `${process.platform}-${process.arch}`
}

// Mirrors node-pty 1.1.0: an `install` script that skips node-gyp whenever a
// prebuild for the host already ships, and a loader preferring build/Release.
function writeUpstreamLikeNodePty(projectDir) {
  const nodePtyDir = nodePtyDirOf(projectDir)
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })
  mkdirSync(join(nodePtyDir, 'scripts'), { recursive: true })

  for (const target of [hostPrebuildTarget(), FOREIGN_PREBUILD_TARGET]) {
    mkdirSync(join(nodePtyDir, 'prebuilds', target), { recursive: true })
    writeFileSync(join(nodePtyDir, 'prebuilds', target, 'pty.node'), '')
  }

  writeFileSync(
    join(nodePtyDir, 'package.json'),
    JSON.stringify(
      {
        name: 'node-pty',
        version: '1.1.0',
        scripts: { install: 'node scripts/prebuild.js || node-gyp rebuild' }
      },
      null,
      2
    )
  )
  writeFileSync(
    join(nodePtyDir, 'scripts', 'prebuild.js'),
    `
const fs = require('node:fs')
const path = require('node:path')

const PREBUILDS_ROOT = path.join(__dirname, '..', 'prebuilds')
const PREBUILD_DIR = path.join(PREBUILDS_ROOT, process.platform + '-' + process.arch)

if (process.env.npm_config_build_from_source === 'true') {
  fs.rmSync(PREBUILDS_ROOT, { recursive: true, force: true })
  process.exit(1)
}
process.exit(fs.existsSync(PREBUILD_DIR) ? 0 : 1)
`
  )
  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

exports.loadNativeModule = function loadNativeModule(name) {
  const dirs = ['build/Release', 'build/Debug', 'prebuilds/' + process.platform + '-' + process.arch]
  for (const d of dirs) {
    for (const r of ['..', '.']) {
      const dir = r + '/' + d + '/'
      if (existsSync(join(__dirname, dir, name + '.node'))) {
        appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-pty load \${name} dir=\${dir}\\n\`)
        return { dir, module: {} }
      }
    }
  }
  throw new Error('Failed to load native module: ' + name + '.node')
}
`
  )
}

function writeFakeNodeGyp(projectDir) {
  const nodeGypDir = join(projectDir, 'node_modules', 'node-gyp')
  mkdirSync(join(nodeGypDir, 'bin'), { recursive: true })
  writeFileSync(
    join(nodeGypDir, 'package.json'),
    JSON.stringify({ name: 'node-gyp', version: '12.3.0', main: 'bin/node-gyp.js' })
  )
  writeFileSync(join(nodeGypDir, 'bin', 'node-gyp.js'), NODE_GYP_SHIM_SOURCE)
}

// Why: unlike writeFakePnpm, this shim re-runs the package's own install
// script the way real `pnpm rebuild` does, so the short-circuit reproduces.
function writePnpmRunningInstallScripts(binDir) {
  mkdirSync(binDir, { recursive: true })
  const shimPath = join(binDir, 'pnpm-shim.cjs')
  writeFileSync(
    shimPath,
    `
const { spawnSync } = require('node:child_process')
const { appendFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`pnpm \${args.join(' ')}\\n\`)

if (args[0] === 'rebuild') {
  for (const pkg of args.slice(1)) {
    const pkgDir = join(process.cwd(), 'node_modules', pkg)
    const { scripts } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    if (!scripts || !scripts.install) {
      continue
    }
    const result = spawnSync(scripts.install, { cwd: pkgDir, shell: true, stdio: 'inherit' })
    if (result.status !== 0) {
      process.exit(result.status ?? 1)
    }
  }
}
`
  )

  const pnpmPath = join(binDir, 'pnpm')
  writeFileSync(pnpmPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(shimPath)})\n`)
  chmodSync(pnpmPath, 0o755)

  // Why: keeps the install script's `|| node-gyp rebuild` fallback genuinely
  // reachable, so a passing test proves the short-circuit, not a missing binary.
  const nodeGypShimPath = join(binDir, 'node-gyp-shim.cjs')
  writeFileSync(nodeGypShimPath, NODE_GYP_SHIM_SOURCE)
  const nodeGypPath = join(binDir, 'node-gyp')
  writeFileSync(nodeGypPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(nodeGypShimPath)})\n`)
  chmodSync(nodeGypPath, 0o755)
}

function writeFakePnpm(binDir) {
  mkdirSync(binDir, { recursive: true })
  const shimPath = join(binDir, 'pnpm-shim.cjs')
  writeFileSync(
    shimPath,
    `
const { appendFileSync, writeFileSync } = require('node:fs')

appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`pnpm \${process.argv.slice(2).join(' ')}\\n\`)
writeFileSync(process.env.ORCA_NATIVE_TEST_MARKER, 'rebuilt')
`
  )

  const posixPnpmPath = join(binDir, 'pnpm')
  writeFileSync(posixPnpmPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(shimPath)})\n`)
  chmodSync(posixPnpmPath, 0o755)
  writeFileSync(
    join(binDir, 'pnpm.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0\\pnpm-shim.cjs" %*\r\n`
  )
}
