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
      expect(log).toContain('pnpm rebuild better-sqlite3\n')
      expect(log.split('\n').filter((line) => line.startsWith('better-sqlite3 '))).toEqual([
        'better-sqlite3 child marker=false',
        'better-sqlite3 child marker=true'
      ])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
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
  const sqliteDir = join(projectDir, 'node_modules', 'better-sqlite3')
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(sqliteDir, { recursive: true })
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })

  writeFileSync(
    join(sqliteDir, 'index.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')

module.exports = class Database {
  constructor() {
    const markerExists = existsSync(process.env.ORCA_NATIVE_TEST_MARKER)
    appendFileSync(
      process.env.ORCA_NATIVE_TEST_LOG,
      \`better-sqlite3 \${process.argv.includes('--check-only') ? 'child' : 'parent'} marker=\${markerExists}\\n\`
    )
    if (!markerExists) {
      throw new Error('ABI mismatch sentinel')
    }
  }

  close() {}
}
`
  )

  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync } = require('node:fs')

exports.loadNativeModule = function loadNativeModule(nativeName) {
  appendFileSync(
    process.env.ORCA_NATIVE_TEST_LOG,
    \`node-pty \${process.argv.includes('--check-only') ? 'child' : 'parent'} \${nativeName}\\n\`
  )
}
`
  )
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
