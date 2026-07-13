import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
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
        expect(readFileSync(logPath, 'utf8')).toContain('pnpm rebuild node-pty\n')
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
        expect(readFileSync(logPath, 'utf8')).toContain('pnpm rebuild node-pty\n')
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
        expect(readFileSync(logPath, 'utf8')).not.toContain('pnpm rebuild node-pty')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )
})

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
  return {
    ...process.env,
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
