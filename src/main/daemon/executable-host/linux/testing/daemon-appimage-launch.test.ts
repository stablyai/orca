import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { buildAppImageDaemonCommand } from '../daemon-appimage-launch'

describe('buildAppImageDaemonCommand', () => {
  const launch = {
    appImagePath: '/apps/Orca.AppImage',
    entryPathInAppDir: 'resources/entry.js',
    appPathInAppDir: 'resources/app.asar',
    appVersion: '1.4.215'
  }
  let root: string | undefined

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = undefined
    }
  })

  function runBootstrap(packagedVersion: string): {
    result: ReturnType<typeof runProcessSync>
    appDir: string
  } {
    const appDir = mkdtempSync(join(tmpdir(), 'orca-appimage-boot-'))
    root = appDir
    mkdirSync(join(appDir, 'resources', 'app.asar'), { recursive: true })
    writeFileSync(
      join(appDir, 'resources', 'app.asar', 'package.json'),
      JSON.stringify({ version: packagedVersion })
    )
    writeFileSync(
      join(appDir, 'resources', 'entry.js'),
      'console.log(JSON.stringify(process.argv.slice(1)))'
    )
    const { args } = buildAppImageDaemonCommand(launch, ['--socket', '/s'], {})
    const result = runProcessSync({
      program: process.execPath,
      args,
      env: { ...process.env, APPDIR: appDir, ELECTRON_RUN_AS_NODE: '1' }
    })
    return { result, appDir }
  }

  it('runs the entry from the child APPDIR with the daemon argv', () => {
    const { result, appDir } = runBootstrap('1.4.215')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      join(appDir, 'resources', 'entry.js'),
      '--socket',
      '/s',
      '--no-sandbox'
    ])
  })

  it('refuses an AppImage replaced by a different release', () => {
    const { result } = runBootstrap('1.5.0')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('AppImage is 1.5.0, expected 1.4.215')
  })
})
