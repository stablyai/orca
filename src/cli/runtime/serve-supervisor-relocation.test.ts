import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SERVE_SUPERVISOR_APP_ROOT_ENV,
  relocateServeSupervisor,
  serveSupervisorSnapshotRoot,
  type SupervisorRelocationDeps
} from './serve-supervisor-relocation'
import {
  restartServeSupervisorIfReplaced,
  type ReplacedAppRestartDeps
} from './serve-replaced-app-restart'

describe('relocateServeSupervisor', () => {
  let root: string
  let resources: string
  let appRoot: string
  let userData: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-supervisor-relocation-'))
    resources = join(root, 'Orca.app', 'Contents', 'Resources')
    appRoot = join(resources, 'app.asar.unpacked')
    userData = join(root, 'profile')
    await mkdir(join(appRoot, 'out', 'cli'), { recursive: true })
    await writeFile(join(appRoot, 'out', 'cli', 'index.js'), 'cli v1')
    await writeFile(join(appRoot, 'out', 'package.json'), '{"version":"1.0.0","commit":"aaa"}')
    await mkdir(join(resources, 'node_modules', 'ws'), { recursive: true })
    await writeFile(join(resources, 'node_modules', 'ws', 'index.js'), 'ws')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const deps = (overrides: Partial<SupervisorRelocationDeps> = {}): SupervisorRelocationDeps => ({
    env: { ELECTRON_RUN_AS_NODE: '1' },
    execPath: join(root, 'Orca.app', 'Contents', 'MacOS', 'Orca'),
    argv: ['/ignored/node', join(appRoot, 'out', 'cli', 'index.js'), 'serve', '--supervise'],
    appRoot,
    userDataPath: userData,
    pid: 4242,
    isProcessAlive: () => false,
    execve: vi.fn(),
    log: vi.fn(),
    ...overrides
  })

  it('re-runs a packaged supervisor from a copy outside the app, pointing back at the app', async () => {
    const d = deps()
    await expect(relocateServeSupervisor(d)).resolves.toBe('relocated')

    expect(d.execve).toHaveBeenCalledTimes(1)
    const [file, args, env] = vi.mocked(d.execve).mock.calls[0]
    expect(file).toBe(d.execPath)
    const snapshotCli = String(args[1])
    expect(snapshotCli.startsWith(serveSupervisorSnapshotRoot(userData))).toBe(true)
    expect(args).toEqual([d.execPath, snapshotCli, 'serve', '--supervise'])
    const snapshot = join(snapshotCli, '..', '..', '..', '..')
    expect(existsSync(join(snapshot, 'node_modules', 'ws', 'index.js'))).toBe(true)
    expect(existsSync(join(snapshot, 'app.asar.unpacked', 'out', 'package.json'))).toBe(true)
    expect(env[SERVE_SUPERVISOR_APP_ROOT_ENV]).toBe(appRoot)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('reuses a finished copy and never relocates twice', async () => {
    const first = deps()
    await relocateServeSupervisor(first)
    const [, firstArgs, firstEnv] = vi.mocked(first.execve).mock.calls[0]
    await writeFile(join(appRoot, 'out', 'cli', 'index.js'), 'changed but same release')

    const again = deps()
    await relocateServeSupervisor(again)
    expect(vi.mocked(again.execve).mock.calls[0][1]).toEqual(firstArgs)

    const relocated = deps({ env: firstEnv })
    await expect(relocateServeSupervisor(relocated)).resolves.toBe('already-relocated')
    expect(relocated.execve).not.toHaveBeenCalled()
  })

  it('stays in place outside a packaged app', async () => {
    for (const d of [
      deps({ env: {} }),
      deps({ env: { ELECTRON_RUN_AS_NODE: '1', ORCA_APP_EXECUTABLE: '/dev/Orca' } }),
      deps({ appRoot: join(root, 'checkout') })
    ]) {
      await expect(relocateServeSupervisor(d)).resolves.toBe('in-place')
      expect(d.execve).not.toHaveBeenCalled()
    }
  })

  // Re-exec closes the AppImage keepalive pipe and unmounts libraries needed by the new image.
  it('stays in place when running from an AppImage, whose files cannot change under it', async () => {
    const d = deps({
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        APPDIR: resources.replace(/\/Resources$/, ''),
        APPIMAGE: '/a/Orca.AppImage'
      }
    })
    await expect(relocateServeSupervisor(d)).resolves.toBe('in-place')
    expect(d.execve).not.toHaveBeenCalled()
    expect(existsSync(serveSupervisorSnapshotRoot(userData))).toBe(false)

    const elsewhere = deps({ env: { ELECTRON_RUN_AS_NODE: '1', APPDIR: join(root, 'other') } })
    await expect(relocateServeSupervisor(elsewhere)).resolves.toBe('relocated')
  })

  it('keeps running in place when the copy or the re-exec fails', async () => {
    await writeFile(join(root, 'blocker'), '')
    const blocked = deps({ userDataPath: join(root, 'blocker') })
    await expect(relocateServeSupervisor(blocked)).resolves.toBe('in-place')
    expect(blocked.execve).not.toHaveBeenCalled()
    expect(blocked.log).toHaveBeenCalledWith(expect.stringContaining('from the app itself'))

    const failing = deps({
      execve: vi.fn(() => {
        throw new Error('ENOENT')
      })
    })
    await expect(relocateServeSupervisor(failing)).resolves.toBe('in-place')
  })

  // Mode 000 does not block root or Windows readers.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'removes a partial copy when copying fails',
    async () => {
      const unreadable = join(appRoot, 'out', 'locked')
      await mkdir(unreadable)
      await writeFile(join(unreadable, 'x.js'), '')
      await chmod(unreadable, 0o000)
      try {
        const d = deps()
        await expect(relocateServeSupervisor(d)).resolves.toBe('in-place')
        expect(d.execve).not.toHaveBeenCalled()
        expect(
          (await readdir(serveSupervisorSnapshotRoot(userData))).filter((name) =>
            name.startsWith('.tmp-')
          )
        ).toEqual([])
      } finally {
        await chmod(unreadable, 0o755)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'copies contents, symlinks and executable bits verbatim',
    async () => {
      const modules = join(resources, 'node_modules')
      await mkdir(join(modules, '.bin'))
      await writeFile(join(modules, 'ws', 'cli.js'), '#!/usr/bin/env node\n')
      await chmod(join(modules, 'ws', 'cli.js'), 0o755)
      await symlink('../ws/cli.js', join(modules, '.bin', 'ws'))
      await symlink('../gone/index.js', join(modules, '.bin', 'dangling'))
      await symlink(join(root, 'outside'), join(modules, 'absolute'))
      await symlink('ws', join(modules, 'ws-alias'))
      const d = deps()
      await expect(relocateServeSupervisor(d)).resolves.toBe('relocated')

      const snapshot = join(String(vi.mocked(d.execve).mock.calls[0][1][1]), '..', '..', '..', '..')
      const copied = join(snapshot, 'node_modules')
      expect(await readFile(join(copied, 'ws', 'index.js'), 'utf8')).toBe('ws')
      expect((await lstat(join(copied, 'ws', 'cli.js'))).mode & 0o777).toBe(0o755)
      expect(await readlink(join(copied, '.bin', 'ws'))).toBe('../ws/cli.js')
      expect(await readlink(join(copied, '.bin', 'dangling'))).toBe('../gone/index.js')
      expect(await readlink(join(copied, 'absolute'))).toBe(join(root, 'outside'))
      expect(await readlink(join(copied, 'ws-alias'))).toBe('ws')
      expect((await lstat(join(copied, 'ws-alias'))).isSymbolicLink()).toBe(true)
      // Copying into an existing directory would nest the tree one level too deep.
      expect(await readdir(snapshot)).toEqual(
        expect.arrayContaining(['app.asar.unpacked', 'node_modules'])
      )
      expect(existsSync(join(snapshot, 'node_modules', 'node_modules'))).toBe(false)
      expect(
        await readFile(join(snapshot, 'app.asar.unpacked', 'out', 'cli', 'index.js'), 'utf8')
      ).toBe('cli v1')
    }
  )

  const releaseCopies = async (): Promise<string[]> =>
    (await readdir(serveSupervisorSnapshotRoot(userData))).filter((name) => !name.startsWith('.'))

  it('removes copies of older releases unless a live supervisor still runs from them', async () => {
    await relocateServeSupervisor(deps({ pid: 100 }))
    await writeFile(join(appRoot, 'out', 'package.json'), '{"version":"1.0.1","commit":"bbb"}')
    await relocateServeSupervisor(deps({ pid: 200, isProcessAlive: (pid) => pid === 100 }))
    expect(await releaseCopies()).toHaveLength(2)

    await writeFile(join(appRoot, 'out', 'package.json'), '{"version":"1.0.2","commit":"ccc"}')
    await relocateServeSupervisor(deps({ pid: 300, isProcessAlive: (pid) => pid === 300 }))
    expect(await releaseCopies()).toHaveLength(1)
  })

  describe('restartServeSupervisorIfReplaced', () => {
    const log = vi.fn()
    beforeEach(async () => {
      await mkdir(join(root, 'Orca.app', 'Contents', 'MacOS'), { recursive: true })
      await writeFile(deps().execPath, '')
      await chmod(deps().execPath, 0o755)
    })
    const restart = (
      env: NodeJS.ProcessEnv,
      argv: string[],
      overrides: Partial<ReplacedAppRestartDeps> = {}
    ) => {
      const d: ReplacedAppRestartDeps = {
        env,
        execPath: deps().execPath,
        execArgv: [],
        argv,
        appRoot,
        pid: 4242,
        execve: vi.fn(),
        log,
        startedFrom: 'old',
        ...overrides
      }
      restartServeSupervisorIfReplaced(d)
      return { execve: vi.mocked(d.execve), execPath: d.execPath }
    }
    const appCli = () => join(appRoot, 'out', 'cli', 'index.js')

    it('re-runs plain serve with the same arguments on the replaced executable', () => {
      const argv = ['/ignored', appCli(), 'serve', '--json']
      const { execve, execPath } = restart({ ELECTRON_RUN_AS_NODE: '1' }, argv)
      expect(execve).toHaveBeenCalledWith(execPath, [execPath, ...argv.slice(1)], {
        ELECTRON_RUN_AS_NODE: '1'
      })
    })

    it('does not restart when the executable is the one it started from, as after a restart', () => {
      const argv = ['/ignored', appCli(), 'serve']
      const installed = statSync(deps().execPath)
      const startedFrom = `${installed.dev}:${installed.ino}`
      expect(restart({}, argv, { startedFrom }).execve).not.toHaveBeenCalled()
      expect(restart({}, argv, { startedFrom: null }).execve).not.toHaveBeenCalled()
      const gone = join(root, 'gone')
      expect(restart({}, argv, { execPath: gone }).execve).not.toHaveBeenCalled()
    })

    // Failed execve aborts natively, so preflight must reject unusable files.
    it('keeps running and logs when the installed app cannot run yet', async () => {
      const argv = ['/ignored', appCli(), 'serve']
      await chmod(deps().execPath, 0o644)
      expect(restart({}, argv).execve).not.toHaveBeenCalled()
      await chmod(deps().execPath, 0o755)
      expect(
        restart({}, ['/ignored', join(root, 'gone.js'), 'serve']).execve
      ).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('not ready to run'))
    })

    it('logs instead of throwing on a runtime that cannot replace its own process', () => {
      const execve = vi.fn(() => {
        throw new Error('this runtime cannot replace its own process')
      })
      expect(() => restart({}, ['/ignored', appCli(), 'serve'], { execve })).not.toThrow()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot replace'))
    })

    it('re-runs a relocated supervisor from the app, which copies the new release aside', async () => {
      const first = deps()
      await relocateServeSupervisor(first)
      const [, relocatedArgs, relocatedEnv] = vi.mocked(first.execve).mock.calls[0]
      await writeFile(join(appRoot, 'out', 'package.json'), '{"version":"1.1.0","commit":"bbb"}')

      const { execve, execPath } = restart(relocatedEnv, relocatedArgs)
      const [, args, env] = execve.mock.calls[0]
      expect(args).toEqual([execPath, appCli(), 'serve', '--supervise'])
      expect(env).not.toHaveProperty(SERVE_SUPERVISOR_APP_ROOT_ENV)

      const again = deps({ env, argv: args })
      await expect(relocateServeSupervisor(again)).resolves.toBe('relocated')
      expect(vi.mocked(again.execve).mock.calls[0][1][1]).not.toBe(relocatedArgs[1])
    })

    it('releases the copy it leaves, so updates under one live pid keep a single copy', async () => {
      const isProcessAlive = (pid: number) => pid === 4242
      let env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
      let argv = deps().argv
      for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
        await writeFile(join(appRoot, 'out', 'package.json'), `{"version":"${version}"}`)
        const relocation = deps({ env, argv, isProcessAlive })
        await expect(relocateServeSupervisor(relocation)).resolves.toBe('relocated')
        const [, relocatedArgs, relocatedEnv] = vi.mocked(relocation.execve).mock.calls[0]
        expect(await releaseCopies()).toHaveLength(1)
        const { execve } = restart(relocatedEnv, relocatedArgs)
        ;[, argv, env] = execve.mock.calls[0]
      }
    })
  })
})
