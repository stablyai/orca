import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPIMAGE_SOURCE_RECORD_NAME,
  appImageNamespaceKey,
  resolveAppImageCacheKey
} from '../../shared/appimage-cache-identity'
import {
  APPIMAGE_SETTLE_MS,
  createSupervisedAppImageUpdate,
  inspectAppImageBuild,
  resolveAppImageBuildWatch,
  restartFromNewAppImage,
  type AppImageRestartDeps
} from './serve-appimage-update'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function backdate(path: string): Promise<void> {
  const past = new Date(Date.now() - 60_000)
  await utimes(path, past, past)
}

/** A service the stable launcher started from the copy unpacked from `Orca.AppImage`. */
async function makeRunningGeneration() {
  const root = await mkdtemp(join(tmpdir(), 'orca-serve-appimage-update-'))
  created.push(root)
  const appImagePath = join(root, 'Orca.AppImage')
  await writeFile(appImagePath, 'build B', { mode: 0o755 })
  await backdate(appImagePath)
  const namespacePath = join(root, 'cache', appImageNamespaceKey(appImagePath))
  const generationPath = join(namespacePath, resolveAppImageCacheKey(appImagePath)!)
  await mkdir(generationPath, { recursive: true })
  await writeFile(join(namespacePath, APPIMAGE_SOURCE_RECORD_NAME), appImagePath)
  return { root, appImagePath, executable: join(generationPath, 'orca-ide') }
}

/** `mv C B`: a new inode at the same path. */
async function swapIn(appImagePath: string, content: string): Promise<void> {
  const replacement = `${appImagePath}.new`
  await writeFile(replacement, content, { mode: 0o755 })
  await backdate(replacement)
  await rename(replacement, appImagePath)
}

function restartDeps(overrides: Partial<AppImageRestartDeps> = {}): AppImageRestartDeps {
  return {
    isStopped: () => false,
    argv: ['/c/orca-ide', '/u/serve-supervisor/id/out/cli/index.js', 'serve', '--supervise'],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_SERVE_SUPERVISOR_APP_ROOT: '/old/app.asar.unpacked',
      ORCA_NODE_OPTIONS: '--max-old-space-size=4096',
      ORCA_USER_DATA_PATH: '/profiles/b1',
      APPIMAGE: '/old/Orca.AppImage',
      APPDIR: '/tmp/.mount_old'
    },
    execve: vi.fn(),
    log: () => undefined,
    probe: async () => null,
    ...overrides
  }
}

describe('supervised serve and a replaced AppImage', () => {
  it('finds the AppImage a stable-launcher service was unpacked from', async () => {
    const { appImagePath, executable } = await makeRunningGeneration()
    const watch = resolveAppImageBuildWatch(executable, {}, 'linux')
    expect(watch?.appImagePath).toBe(appImagePath)
    expect(inspectAppImageBuild(watch!)).toBe('current')
    expect(resolveAppImageBuildWatch(executable, {}, 'darwin')).toBeNull()
  })

  it('ignores a source record that names another AppImage', async () => {
    const { root, executable } = await makeRunningGeneration()
    const namespacePath = join(executable, '..', '..')
    await writeFile(join(namespacePath, APPIMAGE_SOURCE_RECORD_NAME), join(root, 'Other.AppImage'))
    expect(resolveAppImageBuildWatch(executable, {}, 'linux')).toBeNull()
  })

  it('watches the AppImage a mounted supervisor runs from', async () => {
    const { appImagePath, root } = await makeRunningGeneration()
    const mount = join(root, '.mount_Orca')
    const watch = resolveAppImageBuildWatch(
      join(mount, 'orca-ide'),
      { APPIMAGE: appImagePath, APPDIR: mount },
      'linux'
    )
    expect(watch).toEqual({ appImagePath, runningKey: resolveAppImageCacheKey(appImagePath) })
    expect(
      resolveAppImageBuildWatch(
        '/opt/Orca/orca-ide',
        { APPIMAGE: appImagePath, APPDIR: mount },
        'linux'
      )
    ).toBeNull()
  })

  it('reports a swapped AppImage as superseded only once the copy has settled', async () => {
    const { appImagePath, executable } = await makeRunningGeneration()
    const watch = resolveAppImageBuildWatch(executable, {}, 'linux')!
    await swapIn(appImagePath, 'build C')
    expect(inspectAppImageBuild(watch)).toBe('superseded')
    await writeFile(appImagePath, 'build C, still copying')
    expect(inspectAppImageBuild(watch)).toBe('settling')
    expect(inspectAppImageBuild(watch, Date.now() + APPIMAGE_SETTLE_MS + 1_000)).toBe('superseded')
    await rm(appImagePath)
    expect(inspectAppImageBuild(watch)).toBe('current')
  })

  it('execs the new AppImage with its own serve arguments and a clean environment', async () => {
    const { appImagePath, executable } = await makeRunningGeneration()
    const watch = resolveAppImageBuildWatch(executable, {}, 'linux')!
    const deps = restartDeps()

    await restartFromNewAppImage(watch, deps)

    expect(deps.execve).toHaveBeenCalledWith(
      appImagePath,
      [appImagePath, 'serve', '--supervise'],
      expect.objectContaining({
        ORCA_USER_DATA_PATH: '/profiles/b1',
        NODE_OPTIONS: '--max-old-space-size=4096'
      })
    )
    const env = vi.mocked(deps.execve).mock.calls[0]?.[2]
    for (const name of [
      'ELECTRON_RUN_AS_NODE',
      'ORCA_SERVE_SUPERVISOR_APP_ROOT',
      'APPIMAGE',
      'APPDIR'
    ]) {
      expect(env).not.toHaveProperty(name)
    }
  })

  it('keeps the running build when the new AppImage cannot run here, or the service is stopping', async () => {
    const { executable } = await makeRunningGeneration()
    const watch = resolveAppImageBuildWatch(executable, {}, 'linux')!
    const noFuse = restartDeps({
      probe: async () => 'the new AppImage does not run here (fuse: device not found)'
    })
    await expect(restartFromNewAppImage(watch, noFuse)).resolves.toContain('fuse')
    expect(noFuse.execve).not.toHaveBeenCalled()

    const stopping = restartDeps({ isStopped: () => true })
    await expect(restartFromNewAppImage(watch, stopping)).resolves.toBe('the service is stopping')
    expect(stopping.execve).not.toHaveBeenCalled()
  })

  // Why: a build that dies before its own crash brake must not be exec'd on every service restart.
  it('tries a new AppImage once, until a supervisor starts on it or --force', async () => {
    const { root, appImagePath, executable } = await makeRunningGeneration()
    const watch = resolveAppImageBuildWatch(executable, {}, 'linux')!
    await swapIn(appImagePath, 'build C')
    const attemptPath = join(root, 'attempt.json')
    const logs: string[] = []
    const make = (overrides: { force?: boolean; runningKey?: string } = {}) =>
      createSupervisedAppImageUpdate({
        ...restartDeps({ log: (line) => logs.push(line) }),
        watch: { ...watch, runningKey: overrides.runningKey ?? watch.runningKey },
        attemptPath,
        force: overrides.force ?? false
      })

    const first = make()
    expect(first.inspect()).toBe('superseded')
    await first.restart(() => false)
    const candidateKey = resolveAppImageCacheKey(appImagePath)
    expect(JSON.parse(await readFile(attemptPath, 'utf8'))).toEqual({ candidateKey })

    // The new build died early; the service manager restarted the old one.
    const second = make()
    expect(second.inspect()).toBe('current')
    expect(second.inspect()).toBe('current')
    expect(logs.filter((line) => line.includes('did not come up'))).toHaveLength(1)

    expect(make({ force: true }).inspect()).toBe('superseded')
    await make().restart(() => false)
    // A supervisor running the attempted build clears the record.
    make({ runningKey: candidateKey! })
    await expect(readFile(attemptPath, 'utf8')).rejects.toThrow()
  })
})
