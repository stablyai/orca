import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const itCrossHost = process.platform === 'win32' ? it.skip : it
const projectRoot = resolve(import.meta.dirname, '../..')
// Why: cold csc.exe startup exceeds Vitest's 5s unit budget on hosted Windows;
// keep the larger allowance scoped to the real compiler integration test.
function itWindows(name, test) {
  const runner = process.platform === 'win32' ? it : it.skip
  runner(name, { timeout: 15_000 }, test)
}

describe('Windows CLI launcher', () => {
  itCrossHost('fails closed when the Windows launcher cannot be compiled on this host', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'orca cross-host launcher '))
    try {
      const result = spawnSync(
        process.execPath,
        ['config/scripts/build-windows-cli-launcher.mjs', '--output', join(outputRoot, 'orca.exe')],
        { cwd: projectRoot, encoding: 'utf8' }
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Windows CLI launcher')
      expect(result.stderr).toContain('Windows host')
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  itWindows('builds the tmux shim to the requested output', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'orca tmux shim build '))
    try {
      const tmuxOutputPath = join(outputRoot, 'tmux.exe')
      const build = spawnSync(
        process.execPath,
        [
          'config/scripts/build-windows-cli-launcher.mjs',
          '--target',
          'tmux',
          '--output',
          tmuxOutputPath
        ],
        { cwd: projectRoot, encoding: 'utf8' }
      )
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)
      expect(existsSync(tmuxOutputPath), 'tmux.exe should exist at the output path').toBe(true)
      const stats = require('node:fs').statSync(tmuxOutputPath)
      expect(stats.size, 'tmux.exe must be a non-empty PE file').toBeGreaterThan(0)
      // Verify it is a Windows PE by checking the MZ header
      const fd = require('node:fs').openSync(tmuxOutputPath, 'r')
      const header = Buffer.alloc(2)
      require('node:fs').readSync(fd, header, 0, 2, 0)
      require('node:fs').closeSync(fd)
      expect(header[0] === 0x4d && header[1] === 0x5a, 'must have MZ PE header').toBe(true)
      // Verify it contains the tmux shim version sentinel (UTF-16 LE in .NET metadata)
      const content = require('node:fs').readFileSync(tmuxOutputPath)
      const utf16tmux34 = Buffer.from([0x74, 0x00, 0x6d, 0x00, 0x75, 0x00, 0x78, 0x00, 0x20, 0x00, 0x33, 0x00, 0x2e, 0x00, 0x34, 0x00])
      expect(content.indexOf(utf16tmux34), 'tmux.exe must embed the tmux shim version sentinel').toBeGreaterThan(-1)
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  itWindows('preserves a multiline argument from PowerShell through the native launcher', () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'orca cli launcher '))
    try {
      const resourcesPath = join(appRoot, 'resources')
      const launcherPath = join(resourcesPath, 'bin', 'orca.exe')
      const cliPath = join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
      mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
      mkdirSync(dirname(cliPath), { recursive: true })
      copyFileSync(process.execPath, join(appRoot, 'Orca.exe'))
      writeFileSync(
        cliPath,
        `process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  orcaNodeOptions: process.env.ORCA_NODE_OPTIONS ?? null
}))\n`,
        'utf8'
      )

      const build = spawnSync(
        process.execPath,
        ['config/scripts/build-windows-cli-launcher.mjs', '--output', launcherPath],
        { cwd: projectRoot, encoding: 'utf8' }
      )
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)

      const body = 'paragraph one line one\nparagraph one line two\n\nparagraph two'
      const powershell = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '& $env:ORCA_TEST_LAUNCHER orchestration send --body $env:ORCA_TEST_BODY --json'
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: '--no-warnings',
            ORCA_TEST_BODY: body,
            ORCA_TEST_LAUNCHER: launcherPath
          }
        }
      )

      expect(powershell.status, powershell.stderr).toBe(0)
      expect(JSON.parse(powershell.stdout)).toEqual({
        argv: ['orchestration', 'send', '--body', body, '--json'],
        electronRunAsNode: '1',
        nodeOptions: null,
        orcaNodeOptions: '--no-warnings'
      })
    } finally {
      rmSync(appRoot, { recursive: true, force: true })
    }
  })
})
