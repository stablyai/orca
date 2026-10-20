import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SERVE_SUPERVISOR_APP_ROOT_ENV,
  relocateServeSupervisor,
  restartServeSupervisorIfReplaced,
  serveSupervisorSnapshotRoot,
  type SupervisorRelocationDeps,
  type SupervisorRestartDeps
} from './serve-supervisor-relocation'

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
    // The copy keeps the Resources layout, so bare requires still find node_modules.
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

  // Why: re-exec from node mode closes the AppImage runtime's keepalive pipe, so the mount is
  // torn down under the exec and the new image fails to load its libraries (real-host BUG-3).
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

  // Why skip: mode 000 blocks neither root nor Windows readers.
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
    const restart = (
      env: NodeJS.ProcessEnv,
      argv: string[],
      overrides: Partial<SupervisorRestartDeps> = {}
    ) => {
      const d: SupervisorRestartDeps = {
        env,
        execPath: deps().execPath,
        execArgv: [],
        argv,
        appRoot,
        pid: 4242,
        execve: vi.fn(),
        log,
        startedFrom: 'old',
        identify: () => 'new',
        canExecute: () => true,
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
      expect(restart({}, argv, { identify: () => 'old' }).execve).not.toHaveBeenCalled()
      expect(restart({}, argv, { startedFrom: null }).execve).not.toHaveBeenCalled()
      expect(restart({}, argv, { identify: () => null }).execve).not.toHaveBeenCalled()
    })

    // Why: a failed process.execve aborts natively, so nothing may reach it that cannot run.
    it('keeps running and logs when the installed app cannot run yet', () => {
      const argv = ['/ignored', appCli(), 'serve']
      expect(restart({}, argv, { canExecute: () => false }).execve).not.toHaveBeenCalled()
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
