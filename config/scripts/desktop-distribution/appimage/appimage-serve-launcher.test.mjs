import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { writeAppImageServeLauncher } = require('./appimage-serve-launcher.cjs')
const { buildStaticRuntimeAppImage } = require('app-builder-lib/out/targets/appimage/appImageUtil')
const { Arch } = require('builder-util')

describe.skipIf(process.platform === 'win32')('packaged AppImage serve entrypoint', () => {
  it('ships a pre-Chromium CLI route while preserving desktop and --serve launches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-appimage-serve-'))
    const previousTools = process.env.APPIMAGE_TOOLS_PATH
    try {
      const appOutDir = join(root, 'app with spaces')
      const stageDir = join(root, 'stage')
      const tools = join(root, 'tools')
      for (const dir of [appOutDir, stageDir, join(tools, 'runtimes'), join(tools, 'lib/x64')]) {
        mkdirSync(dir, { recursive: true })
      }
      mkdirSync(join(appOutDir, 'resources/bin'), { recursive: true })
      cpSync('resources/linux/bin/orca-ide', join(appOutDir, 'resources/bin/orca-ide'))
      writeFileSync(
        join(appOutDir, 'orca-ide'),
        `#!/usr/bin/env node
console.log(JSON.stringify({args:process.argv.slice(2),node:process.env.ELECTRON_RUN_AS_NODE,
  options:process.env.NODE_OPTIONS,saved:process.env.ORCA_NODE_OPTIONS,appimage:process.env.APPIMAGE}));
process.exit(17);
`,
        { mode: 0o755 }
      )
      writeFileSync(join(appOutDir, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const icon = join(root, 'icon.svg')
      writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg"/>')
      writeFileSync(join(tools, 'runtimes/runtime-x64'), 'runtime fixture')
      writeFileSync(join(tools, 'desktop-file-validate'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      writeFileSync(join(tools, 'mksquashfs'), '#!/bin/sh\n: > "$2"\n', { mode: 0o755 })
      process.env.APPIMAGE_TOOLS_PATH = tools
      writeAppImageServeLauncher({
        appOutDir,
        packager: {
          executableName: 'orca-ide',
          appInfo: { productName: 'Orca', productFilename: 'Orca' },
          config: { appImage: {} }
        }
      })
      await buildStaticRuntimeAppImage('1.0.3', {
        appDir: appOutDir,
        stageDir,
        arch: Arch.x64,
        output: join(root, 'orca.AppImage'),
        options: {
          executableName: 'orca-ide',
          productName: 'Orca',
          productFilename: 'Orca',
          desktopEntry: '[Desktop Entry]\nType=Application\nName=Orca\nExec=AppRun\n',
          icons: [{ file: icon, size: 128 }]
        }
      })
      const appImage = '/opt/Orca with spaces.AppImage'
      const env = { ...process.env, APPDIR: stageDir, APPIMAGE: appImage }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      delete env.ORCA_NODE_OPTIONS
      const args = ['serve', '--port', '0', '--pairing-address', 'value $HOME `literal`\nspace']
      const cli = spawnSync(join(stageDir, 'AppRun'), args, {
        env: { ...env, NODE_OPTIONS: '--max-old-space-size=256' },
        encoding: 'utf8'
      })
      expect(cli.status, cli.stderr).toBe(17)
      expect(JSON.parse(cli.stdout)).toEqual({
        args: [join(stageDir, 'resources/app.asar.unpacked/out/cli/index.js'), ...args],
        node: '1',
        saved: '--max-old-space-size=256',
        appimage: appImage
      })
      for (const args of [[], ['--serve', '--serve-port', '0']]) {
        const desktop = spawnSync(join(stageDir, 'AppRun'), args, { env, encoding: 'utf8' })
        expect(desktop.status, desktop.stderr).toBe(17)
        expect(JSON.parse(desktop.stdout)).toEqual({
          args: ['--no-sandbox', ...args],
          appimage: appImage
        })
      }
      execFileSync('bash', ['-n', join(stageDir, 'AppRun')])
    } finally {
      if (previousTools === undefined) {
        delete process.env.APPIMAGE_TOOLS_PATH
      } else {
        process.env.APPIMAGE_TOOLS_PATH = previousTools
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
