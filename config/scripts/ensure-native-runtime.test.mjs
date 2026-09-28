import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  mkTempProject,
  writeFakeElectronRebuild,
  writeFakeUsableElectronPackage,
  writeFakeWindowsProcessTree
} from './rebuild-native-deps-test-fixtures.mjs'

function stageEnsureScript(projectDir) {
  const path = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
  copyFileSync(fileURLToPath(new URL('./ensure-native-runtime.mjs', import.meta.url)), path)
  return path
}

describe('ensure-native-runtime', () => {
  it.skipIf(process.platform === 'win32')(
    'accepts Node without any installed native package',
    () => {
      const projectDir = mkTempProject()
      try {
        const result = spawnSync(
          process.execPath,
          [stageEnsureScript(projectDir), '--runtime=node'],
          {
            cwd: projectDir,
            encoding: 'utf8'
          }
        )
        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).not.toContain('Rebuilding')
        expect(existsSync(join(projectDir, 'node_modules'))).toBe(false)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'repairs Electron metadata even without rebuildable addons',
    () => {
      const projectDir = mkTempProject()
      try {
        const logPath = join(projectDir, 'rebuild.log')
        writeFakeUsableElectronPackage(projectDir)
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        rmSync(join(projectDir, 'node_modules/electron/path.txt'))
        const result = spawnSync(
          process.execPath,
          [stageEnsureScript(projectDir), '--runtime=electron'],
          {
            cwd: projectDir,
            encoding: 'utf8',
            env: {
              ...process.env,
              ELECTRON_INSTALL_PLATFORM: 'linux',
              ORCA_REBUILD_TEST_LOG: logPath
            }
          }
        )
        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(join(projectDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
          'electron'
        )
        expect(existsSync(logPath)).toBe(false)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rechecks failed Windows addons in fresh Node children',
    () => {
      const projectDir = mkTempProject()
      try {
        const logPath = join(projectDir, 'native.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        const registryDir = join(projectDir, 'node_modules', '@orca', 'windows-registry')
        mkdirSync(registryDir, { recursive: true })
        writeFileSync(
          join(registryDir, 'package.json'),
          '{"name":"@orca/windows-registry","main":"index.js"}'
        )
        writeFileSync(
          join(registryDir, 'index.js'),
          `
const { appendFileSync, existsSync } = require('node:fs');
exports.HK = { CU: 0x80000001 };
exports.getRegistryKey = () => {
  const ready = existsSync(process.env.ORCA_NATIVE_TEST_MARKER);
  appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, JSON.stringify({ ready, pid: process.pid }) + '\\n');
  if (!ready) throw new Error('ABI mismatch sentinel');
};`
        )
        writeFakeWindowsProcessTree(projectDir)
        const binDir = join(projectDir, 'bin')
        mkdirSync(binDir)
        writeFileSync(
          join(binDir, 'rebuild.cjs'),
          "require('node:fs').writeFileSync(process.env.ORCA_NATIVE_TEST_MARKER, process.cwd())"
        )
        writeFileSync(
          join(binDir, 'pnpm.cmd'),
          `@echo off\r\n"${process.execPath}" "%~dp0rebuild.cjs"\r\n`
        )
        const pathKey =
          Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
        const result = spawnSync(
          process.execPath,
          [stageEnsureScript(projectDir), '--runtime=node'],
          {
            cwd: projectDir,
            encoding: 'utf8',
            env: {
              ...process.env,
              [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ''}`,
              ORCA_NATIVE_TEST_LOG: logPath,
              ORCA_NATIVE_TEST_MARKER: markerPath
            }
          }
        )
        expect(result.status, result.stderr).toBe(0)
        const probes = readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(probes.map((row) => row.ready)).toEqual([false, true])
        expect(probes[0].pid).not.toBe(probes[1].pid)
        expect(readFileSync(markerPath, 'utf8')).toBe(registryDir)
        expect(result.stderr).not.toContain('Rebuilding @vscode/windows-process-tree')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )
})
