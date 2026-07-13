import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const itWindows = process.platform === 'win32' ? it : it.skip
const projectRoot = resolve(import.meta.dirname, '../..')

describe('Windows CLI launcher', () => {
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
