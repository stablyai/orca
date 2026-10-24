import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAppImageExtractedRoot } from '../cli/appimage-extracted-root'
import {
  buildAppImageGenerationDaemonCommand,
  resolveAppImageGenerationDaemonLaunch
} from './daemon-appimage-generation-launch'

const { resolveIdentity } = vi.hoisted(() => ({ resolveIdentity: vi.fn() }))
vi.mock('../appimage-runtime-identity', () => ({ resolveAppImageRuntimeIdentity: resolveIdentity }))

const APPDIR = '/tmp/.mount_orcaAbC'
const ENTRY_IN_APPDIR = 'resources/app.asar.unpacked/out/main/daemon-entry.js'
let root = ''
let appImagePath = ''
let cacheRootPath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-generation-launch-'))
  appImagePath = join(root, 'Orca.AppImage')
  cacheRootPath = join(root, 'cache')
  writeFileSync(appImagePath, 'appimage')
  resolveIdentity.mockReturnValue({ appImagePath })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  resolveIdentity.mockReset()
})

function input(overrides: { appVersion?: string; environment?: NodeJS.ProcessEnv } = {}) {
  return {
    entryPath: `${APPDIR}/${ENTRY_IN_APPDIR}`,
    appVersion: overrides.appVersion ?? '1.4.226',
    environment: overrides.environment ?? { APPIMAGE: appImagePath, APPDIR },
    cacheRootPath
  }
}

function extractGeneration(options: { node?: boolean; version?: string } = {}): string {
  const generation = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!.rootPath
  const launcher = join(generation, 'resources', 'bin', 'orca-ide')
  mkdirSync(join(launcher, '..'), { recursive: true })
  writeFileSync(launcher, '#!/bin/sh\n')
  chmodSync(launcher, 0o755)
  const entry = join(generation, ENTRY_IN_APPDIR)
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, '')
  writeFileSync(
    join(generation, 'resources', 'app.asar.unpacked', 'out', 'package.json'),
    JSON.stringify({ name: 'orca-compiled-output', version: options.version ?? '1.4.226' })
  )
  if (options.node !== false) {
    const node = join(generation, 'resources', 'node-runtime', 'bin', 'node')
    mkdirSync(join(node, '..'), { recursive: true })
    writeFileSync(node, '')
  }
  return generation
}

describe('resolveAppImageGenerationDaemonLaunch', () => {
  it('runs the daemon on the bundled Node of the extracted copy of this AppImage', () => {
    const generation = extractGeneration()
    expect(resolveAppImageGenerationDaemonLaunch(input())).toEqual({
      launch: {
        generationRoot: generation,
        nodePath: join(generation, 'resources', 'node-runtime', 'bin', 'node'),
        entryPath: join(generation, ENTRY_IN_APPDIR),
        // Match own-mount identity so either host can be adopted.
        identityPath: join(appImagePath, ENTRY_IN_APPDIR)
      }
    })
  })

  it('says nothing off a validated AppImage', () => {
    extractGeneration()
    resolveIdentity.mockReturnValue(null)
    expect(resolveAppImageGenerationDaemonLaunch(input())).toBeNull()
    expect(resolveAppImageGenerationDaemonLaunch(input({ environment: {} }))).toBeNull()
  })

  it('falls back when the AppImage was never extracted', () => {
    expect(resolveAppImageGenerationDaemonLaunch(input())).toEqual({
      fallback: 'no-extracted-copy'
    })
  })

  it('falls back when the extracted copy predates the bundled Node', () => {
    extractGeneration({ node: false })
    expect(resolveAppImageGenerationDaemonLaunch(input())).toEqual({
      fallback: 'no-bundled-node'
    })
  })

  it('falls back when the file at $APPIMAGE is no longer the running release', () => {
    extractGeneration({ version: '1.4.227' })
    expect(resolveAppImageGenerationDaemonLaunch(input())).toEqual({
      fallback: 'version-mismatch'
    })
  })
})

describe('buildAppImageGenerationDaemonCommand', () => {
  it.runIf(process.platform === 'linux')(
    'runs plain Node, with no Electron or AppImage runtime variables',
    () => {
      const launch = {
        generationRoot: '/cache/ns/gen',
        nodePath: '/cache/ns/gen/resources/node-runtime/bin/node',
        entryPath: `/cache/ns/gen/${ENTRY_IN_APPDIR}`,
        identityPath: `/apps/Orca.AppImage/${ENTRY_IN_APPDIR}`
      }
      const command = buildAppImageGenerationDaemonCommand(launch, ['--socket', '/s'], {
        APPDIR,
        APPIMAGE: '/apps/Orca.AppImage',
        ELECTRON_RUN_AS_NODE: '1',
        PATH: `${APPDIR}/usr/bin:/usr/bin`,
        HOME: '/home/me'
      })
      expect(command).toEqual({
        command: launch.nodePath,
        args: [launch.entryPath, '--socket', '/s'],
        env: { PATH: '/usr/bin', HOME: '/home/me' }
      })
    }
  )
})
