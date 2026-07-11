import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const processesToCleanUp = new Set<number>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'ESRCH') {
      return false
    }
    throw error
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await sleep(50)
  }
}

function readPidFile(pidFile: string): number[] {
  return readFileSync(pidFile, 'utf8')
    .trim()
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isFinite(pid))
}

function trackPidFile(pidFile: string): number[] {
  const pids = readPidFile(pidFile)
  for (const pid of pids) {
    processesToCleanUp.add(pid)
  }
  return pids
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = 5000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Timed out waiting for dev wrapper exit'))
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
  })
}

async function stopWrapper(
  wrapper: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (wrapper.pid) {
    processesToCleanUp.add(wrapper.pid)
  }
  if (wrapper.exitCode === null && wrapper.signalCode === null) {
    wrapper.kill('SIGINT')
  }
  const result = await waitForExit(wrapper)
  if (wrapper.pid) {
    processesToCleanUp.delete(wrapper.pid)
  }
  return result
}

async function stopWrapperAndTrackedPids(wrapper: ChildProcess, pids: number[]): Promise<void> {
  await stopWrapper(wrapper)
  await waitFor(() => pids.every((pid) => !processExists(pid)))
  for (const pid of pids) {
    processesToCleanUp.delete(pid)
  }
}

function devWrapperTestEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCA_DEV_')) {
      delete env[key]
    }
  }
  delete env.ELECTRON_EXEC_PATH
  return { ...env, ...extra }
}

describe('run-electron-vite-dev', () => {
  afterEach(async () => {
    for (const pid of processesToCleanUp) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        if (code !== 'ESRCH') {
          throw error
        }
      }
    }
    await sleep(100)
    for (const pid of processesToCleanUp) {
      try {
        if (processExists(pid)) {
          process.kill(pid, 'SIGKILL')
        }
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        if (code !== 'ESRCH') {
          throw error
        }
      }
    }
    processesToCleanUp.clear()
  })

  it.skipIf(process.platform === 'win32')(
    'kills the descendant process tree on SIGINT',
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
      const pidFile = join(tempDir, 'grandchild.pid')
      const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
      const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')

      const wrapper = spawn(process.execPath, [wrapperPath], {
        cwd: resolve('.'),
        env: devWrapperTestEnv({
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
          ORCA_SKIP_DEV_WEB_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile
        }),
        stdio: 'ignore'
      })

      expect(wrapper.pid).toBeTypeOf('number')
      processesToCleanUp.add(wrapper.pid!)

      await waitFor(() => {
        try {
          return readFileSync(pidFile, 'utf8').trim().length > 0
        } catch {
          return false
        }
      })

      const [fakeCliPid, grandchildPid] = trackPidFile(pidFile)
      expect(Number.isFinite(fakeCliPid)).toBe(true)
      expect(Number.isFinite(grandchildPid)).toBe(true)
      expect(processExists(fakeCliPid)).toBe(true)
      expect(processExists(grandchildPid)).toBe(true)

      const { code } = await stopWrapper(wrapper)
      expect(code).toBe(130)

      await waitFor(() => !processExists(fakeCliPid) && !processExists(grandchildPid))
      processesToCleanUp.delete(fakeCliPid)
      processesToCleanUp.delete(grandchildPid)
    }
  )

  it('forwards dev instance identity to electron-vite', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
    const pidFile = join(tempDir, 'grandchild.pid')
    const envFile = join(tempDir, 'env.json')
    const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
    const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')

    const wrapper = spawn(process.execPath, [wrapperPath, '--remote-debugging-port=9444'], {
      cwd: resolve('.'),
      env: devWrapperTestEnv({
        ORCA_ELECTRON_VITE_CLI: fakeCliPath,
        ORCA_SKIP_DEV_CLI_PREPARE: '1',
        ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
        ORCA_SKIP_DEV_WEB_PREPARE: '1',
        ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
        ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
        ORCA_DEV_BRANCH: 'feature/billing-shell',
        ORCA_DEV_WORKTREE_NAME: 'payment-ui'
      }),
      stdio: 'ignore'
    })

    expect(wrapper.pid).toBeTypeOf('number')
    processesToCleanUp.add(wrapper.pid!)

    await waitFor(() => {
      try {
        return readFileSync(envFile, 'utf8').trim().length > 0
      } catch {
        return false
      }
    })

    const trackedPids = trackPidFile(pidFile)

    const envSnapshot = JSON.parse(readFileSync(envFile, 'utf8')) as {
      args: string[]
      label: string
      branch: string
      worktreeName: string
      repoRoot: string
      badgeLabel: string | null
      dockTitle: string
      stableName: string | null
      electronExecPath: string | null
    }
    expect(envSnapshot.args).toContain('--remote-debugging-port=9444')
    expect(envSnapshot.label).toBe('payment-ui @ feature/billing-shell')
    expect(envSnapshot.branch).toBe('feature/billing-shell')
    expect(envSnapshot.worktreeName).toBe('payment-ui')
    expect(envSnapshot.repoRoot).toBe(resolve('.'))
    expect(envSnapshot.badgeLabel).toBeNull()
    expect(envSnapshot.dockTitle).toBe('Orca: feature/billing-shell')
    expect(envSnapshot.stableName).toBeNull()
    expect(envSnapshot.electronExecPath).toBeNull()

    await stopWrapperAndTrackedPids(wrapper, trackedPids)
  })

  it.skipIf(process.platform === 'win32')(
    'prepares userData orca and orca-dev wrappers for dev terminals',
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
      const userDataPath = join(tempDir, 'userData')
      const pidFile = join(tempDir, 'grandchild.pid')
      const envFile = join(tempDir, 'env.json')
      const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
      const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')

      const wrapper = spawn(process.execPath, [wrapperPath], {
        cwd: resolve('.'),
        env: devWrapperTestEnv({
          ORCA_DEV_USER_DATA_PATH: userDataPath,
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
          ORCA_SKIP_DEV_WEB_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
          ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile
        }),
        stdio: 'ignore'
      })

      expect(wrapper.pid).toBeTypeOf('number')
      processesToCleanUp.add(wrapper.pid!)

      await waitFor(() => {
        try {
          return readFileSync(envFile, 'utf8').trim().length > 0
        } catch {
          return false
        }
      })

      const trackedPids = trackPidFile(pidFile)
      const devWrapper = readFileSync(join(userDataPath, 'cli', 'bin', 'orca-dev'), 'utf8')
      const publicAliasWrapper = readFileSync(join(userDataPath, 'cli', 'bin', 'orca'), 'utf8')
      expect(publicAliasWrapper).toBe(devWrapper)
      expect(publicAliasWrapper).toContain('ORCA_USER_DATA_PATH')
      expect(publicAliasWrapper).toContain('out/cli/index.js')

      await stopWrapperAndTrackedPids(wrapper, trackedPids)
    }
  )

  it('consumes the stable-name flag before forwarding args to electron-vite', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
    const pidFile = join(tempDir, 'grandchild.pid')
    const envFile = join(tempDir, 'env.json')
    const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
    const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')

    const wrapper = spawn(
      process.execPath,
      [wrapperPath, '--stable-name', '--remote-debugging-port=9445'],
      {
        cwd: resolve('.'),
        env: devWrapperTestEnv({
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_SKIP_DEV_WEB_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
          ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
          ORCA_DEV_BRANCH: 'feature/stable-name',
          ORCA_DEV_WORKTREE_NAME: 'stable-ui'
        }),
        stdio: 'ignore'
      }
    )

    expect(wrapper.pid).toBeTypeOf('number')
    processesToCleanUp.add(wrapper.pid!)

    await waitFor(() => {
      try {
        return readFileSync(envFile, 'utf8').trim().length > 0
      } catch {
        return false
      }
    })

    const trackedPids = trackPidFile(pidFile)

    const envSnapshot = JSON.parse(readFileSync(envFile, 'utf8')) as {
      args: string[]
      stableName: string | null
      electronExecPath: string | null
    }
    expect(envSnapshot.args).not.toContain('--stable-name')
    expect(envSnapshot.args).toContain('--remote-debugging-port=9445')
    expect(envSnapshot.stableName).toBe('1')
    expect(envSnapshot.electronExecPath).toBeNull()

    await stopWrapperAndTrackedPids(wrapper, trackedPids)
  })

  it.skipIf(process.platform !== 'darwin')(
    'rebuilds the copied Electron app when Chromium resources are missing',
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
      const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
      const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')
      const baseEnv = devWrapperTestEnv({
        ORCA_ELECTRON_VITE_CLI: fakeCliPath,
        ORCA_SKIP_DEV_CLI_PREPARE: '1',
        ORCA_SKIP_DEV_WEB_PREPARE: '1',
        ORCA_DEV_BRANCH: 'feature/rebuild-electron-app',
        ORCA_DEV_WORKTREE_NAME: 'electron-app-rebuild'
      })

      async function runWrapper(runId: string): Promise<{ electronExecPath: string }> {
        const pidFile = join(tempDir, `${runId}.pid`)
        const envFile = join(tempDir, `${runId}.json`)
        const wrapper = spawn(process.execPath, [wrapperPath, '--remote-debugging-port=9448'], {
          cwd: resolve('.'),
          env: {
            ...baseEnv,
            ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
            ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile
          },
          stdio: 'ignore'
        })

        expect(wrapper.pid).toBeTypeOf('number')
        processesToCleanUp.add(wrapper.pid!)

        await waitFor(() => {
          try {
            return readFileSync(envFile, 'utf8').trim().length > 0
          } catch {
            return false
          }
        }, 20000)

        const trackedPids = trackPidFile(pidFile)

        const envSnapshot = JSON.parse(readFileSync(envFile, 'utf8')) as {
          electronExecPath: string | null
        }
        expect(envSnapshot.electronExecPath).toBeTypeOf('string')
        await stopWrapperAndTrackedPids(wrapper, trackedPids)
        return { electronExecPath: envSnapshot.electronExecPath! }
      }

      let distDir: string | null = null
      try {
        const firstRun = await runWrapper('first')
        const appPath = dirname(dirname(dirname(firstRun.electronExecPath)))
        distDir = dirname(appPath)
        const icuDataPath = join(
          appPath,
          'Contents',
          'Frameworks',
          'Electron Framework.framework',
          'Resources',
          'icudtl.dat'
        )
        expect(existsSync(icuDataPath)).toBe(true)

        rmSync(icuDataPath, { force: true })
        expect(existsSync(icuDataPath)).toBe(false)

        const secondRun = await runWrapper('second')
        expect(secondRun.electronExecPath).toBe(firstRun.electronExecPath)
        expect(existsSync(icuDataPath)).toBe(true)
      } finally {
        if (distDir) {
          rmSync(distDir, { recursive: true, force: true })
        }
      }
    },
    30000
  )

  it.skipIf(process.platform !== 'darwin')(
    'preserves relative Electron framework symlinks in the copied mac dev app',
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
      const pidFile = join(tempDir, 'grandchild.pid')
      const envFile = join(tempDir, 'env.json')
      const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
      const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')

      const wrapper = spawn(process.execPath, [wrapperPath, '--remote-debugging-port=9448'], {
        cwd: resolve('.'),
        env: devWrapperTestEnv({
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_SKIP_DEV_WEB_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
          ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
          ORCA_DEV_BRANCH: 'feature/framework-symlinks',
          ORCA_DEV_WORKTREE_NAME: 'symlink-ui'
        }),
        stdio: 'ignore'
      })

      expect(wrapper.pid).toBeTypeOf('number')
      processesToCleanUp.add(wrapper.pid!)

      await waitFor(() => {
        try {
          return readFileSync(envFile, 'utf8').trim().length > 0
        } catch {
          return false
        }
      }, 20000)

      const trackedPids = trackPidFile(pidFile)

      const envSnapshot = JSON.parse(readFileSync(envFile, 'utf8')) as {
        electronExecPath: string | null
      }
      expect(envSnapshot.electronExecPath).toBeTypeOf('string')

      const appPath = dirname(dirname(dirname(envSnapshot.electronExecPath!)))
      const frameworkPath = join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework')

      expect(readlinkSync(join(frameworkPath, 'Resources'))).toBe('Versions/Current/Resources')
      expect(readlinkSync(join(frameworkPath, 'Electron Framework'))).toBe(
        'Versions/Current/Electron Framework'
      )
      expect(readlinkSync(join(frameworkPath, 'Versions', 'Current'))).toBe('A')

      await stopWrapperAndTrackedPids(wrapper, trackedPids)
    },
    30000
  )
})
