import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
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

describe('run-electron-vite-dev', () => {
  afterEach(() => {
    for (const pid of processesToCleanUp) {
      try {
        process.kill(pid, 'SIGKILL')
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
        env: {
          ...process.env,
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile
        },
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

      const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      expect(Number.isFinite(grandchildPid)).toBe(true)
      processesToCleanUp.add(grandchildPid)
      expect(processExists(grandchildPid)).toBe(true)

      const exitPromise = new Promise<number | null>((resolveExit) => {
        wrapper.on('exit', (code) => {
          resolveExit(code)
        })
      })

      wrapper.kill('SIGINT')
      const exitCode = await exitPromise
      expect(exitCode).toBe(130)

      await waitFor(() => !processExists(grandchildPid))
      processesToCleanUp.delete(grandchildPid)
      processesToCleanUp.delete(wrapper.pid!)
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
      env: {
        ...process.env,
        ORCA_ELECTRON_VITE_CLI: fakeCliPath,
        ORCA_SKIP_DEV_CLI_PREPARE: '1',
        ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
        ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
        ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
        ORCA_DEV_BRANCH: 'feature/billing-shell',
        ORCA_DEV_WORKTREE_NAME: 'payment-ui'
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
    })

    const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (Number.isFinite(grandchildPid)) {
      processesToCleanUp.add(grandchildPid)
    }

    const envSnapshot = JSON.parse(readFileSync(envFile, 'utf8')) as {
      args: string[]
      label: string
      branch: string
      worktreeName: string
      repoRoot: string
      badgeLabel: string
      dockTitle: string
      stableName: string | null
      electronExecPath: string | null
    }
    expect(envSnapshot.args).toContain('--remote-debugging-port=9444')
    expect(envSnapshot.label).toBe('payment-ui @ feature/billing-shell')
    expect(envSnapshot.branch).toBe('feature/billing-shell')
    expect(envSnapshot.worktreeName).toBe('payment-ui')
    expect(envSnapshot.repoRoot).toBe(resolve('.'))
    expect(envSnapshot.badgeLabel).toMatch(/^PU[A-Z0-9]{2}$/)
    expect(envSnapshot.dockTitle).toMatch(/^Orca Dev \[PU[A-Z0-9]{2}\]: feature\/billing-shell$/)
    expect(envSnapshot.stableName).toBeNull()
    expect(envSnapshot.electronExecPath).toBeNull()

    wrapper.kill('SIGINT')
  })

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
        env: {
          ...process.env,
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
          ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
          ORCA_DEV_BRANCH: 'feature/stable-name',
          ORCA_DEV_WORKTREE_NAME: 'stable-ui'
        },
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

    const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (Number.isFinite(grandchildPid)) {
      processesToCleanUp.add(grandchildPid)
    }

    const envSnapshot = JSON.parse(readFileSync(envFile, 'utf8')) as {
      args: string[]
      stableName: string | null
      electronExecPath: string | null
    }
    expect(envSnapshot.args).not.toContain('--stable-name')
    expect(envSnapshot.args).toContain('--remote-debugging-port=9445')
    expect(envSnapshot.stableName).toBe('1')
    expect(envSnapshot.electronExecPath).toBeNull()

    wrapper.kill('SIGINT')
  })
})
