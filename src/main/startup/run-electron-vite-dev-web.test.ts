import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await sleep(50)
  }
}

function stashWebBuild(): () => void {
  const outWebPath = resolve('out/web')
  if (!existsSync(outWebPath)) {
    return () => {
      rmSync(outWebPath, { recursive: true, force: true })
    }
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-web-stash-'))
  const stashedPath = join(tempDir, 'web')
  renameSync(outWebPath, stashedPath)
  return () => {
    rmSync(outWebPath, { recursive: true, force: true })
    mkdirSync(resolve('out'), { recursive: true })
    renameSync(stashedPath, outWebPath)
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('run-electron-vite-dev web client prepare', () => {
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

  it('skips the initial web client build when no bundle exists', async () => {
    const restoreWebBuild = stashWebBuild()
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
    const pidFile = join(tempDir, 'grandchild.pid')
    const envFile = join(tempDir, 'env.json')
    const viteFile = join(tempDir, 'vite.txt')
    const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
    const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')
    const fakeVitePath = resolve('src/main/startup/__fixtures__/fake-vite-cli.mjs')
    let stderr = ''

    try {
      const wrapper = spawn(process.execPath, [wrapperPath, '--remote-debugging-port=9446'], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_VITE_CLI: fakeVitePath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
          ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
          ORCA_DEV_WRAPPER_TEST_VITE_FILE: viteFile
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })

      expect(wrapper.pid).toBeTypeOf('number')
      processesToCleanUp.add(wrapper.pid!)
      wrapper.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })

      await waitFor(() => {
        try {
          return readFileSync(envFile, 'utf8').trim().length > 0
        } catch {
          return false
        }
      })

      expect(existsSync(viteFile)).toBe(false)
      expect(stderr).toContain('Web client bundle missing; skipping pairing web build.')

      const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (Number.isFinite(grandchildPid)) {
        processesToCleanUp.add(grandchildPid)
      }

      wrapper.kill('SIGINT')
    } finally {
      restoreWebBuild()
    }
  })

  it('builds the missing web client bundle when explicitly requested', async () => {
    const restoreWebBuild = stashWebBuild()
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
    const pidFile = join(tempDir, 'grandchild.pid')
    const envFile = join(tempDir, 'env.json')
    const viteFile = join(tempDir, 'vite.txt')
    const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
    const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')
    const fakeVitePath = resolve('src/main/startup/__fixtures__/fake-vite-cli.mjs')

    try {
      const wrapper = spawn(process.execPath, [wrapperPath, '--remote-debugging-port=9447'], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_VITE_CLI: fakeVitePath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
          ORCA_DEV_WEB_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
          ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
          ORCA_DEV_WRAPPER_TEST_VITE_FILE: viteFile
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

      expect(readFileSync(viteFile, 'utf8')).toContain('build')

      const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (Number.isFinite(grandchildPid)) {
        processesToCleanUp.add(grandchildPid)
      }

      wrapper.kill('SIGINT')
    } finally {
      restoreWebBuild()
    }
  })
})
