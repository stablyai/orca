import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { buildAppImageDaemonCommand, resolveAppImageDaemonLaunch } from './daemon-appimage-launch'

const { resolveIdentity } = vi.hoisted(() => ({ resolveIdentity: vi.fn() }))
vi.mock('../appimage-runtime-identity', () => ({ resolveAppImageRuntimeIdentity: resolveIdentity }))

const APPDIR = '/tmp/.mount_orcaAbC'
const FUSE_MOUNTINFO = `953 65 0:108 / ${APPDIR} ro,nosuid,nodev,relatime shared:1 - fuse.Orca.AppImage Orca.AppImage ro,user_id=1000`
const INPUT = {
  entryPath: `${APPDIR}/resources/app.asar.unpacked/out/main/daemon-entry.js`,
  appPath: `${APPDIR}/resources/app.asar`,
  appVersion: '1.4.215',
  environment: { APPIMAGE: '/apps/Orca.AppImage', APPDIR },
  readMountInfo: () => FUSE_MOUNTINFO
}

afterEach(() => resolveIdentity.mockReset())

describe('resolveAppImageDaemonLaunch', () => {
  it('resolves paths relative to APPDIR on a FUSE-mounted AppImage', () => {
    resolveIdentity.mockReturnValue({ appImagePath: '/apps/Orca.AppImage' })
    expect(resolveAppImageDaemonLaunch(INPUT)).toEqual({
      appImagePath: '/apps/Orca.AppImage',
      entryPathInAppDir: 'resources/app.asar.unpacked/out/main/daemon-entry.js',
      appPathInAppDir: 'resources/app.asar',
      appVersion: '1.4.215'
    })
  })

  it('keeps the in-mount launch off a validated AppImage', () => {
    resolveIdentity.mockReturnValue(null)
    expect(resolveAppImageDaemonLaunch(INPUT)).toBeNull()
  })

  it('keeps the in-mount launch for extract-and-run payloads', () => {
    resolveIdentity.mockReturnValue({ appImagePath: '/apps/Orca.AppImage' })
    const extracted = `953 65 0:34 / /tmp rw - tmpfs tmpfs rw`
    expect(resolveAppImageDaemonLaunch({ ...INPUT, readMountInfo: () => extracted })).toBeNull()
  })

  it('decodes escaped mount points', () => {
    resolveIdentity.mockReturnValue({ appImagePath: '/apps/Orca.AppImage' })
    const spaced = '/tmp/a b'
    const launch = resolveAppImageDaemonLaunch({
      ...INPUT,
      entryPath: `${spaced}/resources/entry.js`,
      appPath: `${spaced}/resources/app.asar`,
      environment: { APPDIR: spaced },
      readMountInfo: () => '1 2 0:1 / /tmp/a\\040b ro - fuse.x x ro'
    })
    expect(launch?.entryPathInAppDir).toBe('resources/entry.js')
  })
})

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

  // Why runIf: the env scrub it reuses is a no-op off Linux.
  it.runIf(process.platform === 'linux')(
    'drops the parent mount from the inherited loader and PATH entries',
    () => {
      const { command, args, env } = buildAppImageDaemonCommand(launch, ['--socket', '/s'], {
        APPDIR,
        APPIMAGE: '/apps/Orca.AppImage',
        PATH: `${APPDIR}:${APPDIR}/usr/sbin:/usr/bin`,
        LD_LIBRARY_PATH: `${APPDIR}/usr/lib`,
        HOME: '/home/u'
      })
      expect(command).toBe('/apps/Orca.AppImage')
      expect(args.slice(2)).toEqual(['--', '--socket', '/s', '--no-sandbox'])
      expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u' })
    }
  )

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
