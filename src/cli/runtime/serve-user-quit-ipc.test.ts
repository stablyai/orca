import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it, vi } from 'vitest'
import {
  SERVE_SUPERVISOR_ENV,
  SERVE_SUPERVISED_SHUTDOWN_GRACE_MS,
  SERVE_SUPERVISOR_STOP_EXIT_CODE
} from '../../shared/serve-supervision'
import { superviseForegroundServe } from './serve-update-supervisor'

function compiledSource(path: string): string {
  return ts.transpileModule(readFileSync(join(process.cwd(), path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

function childSource(): string {
  return `
  function load(source, imports = {}) {
    const exports = {}
    new Function('exports', 'require', source)(exports, (name) => imports[name] ?? require(name))
    return exports
  }
  const deadline = load(${JSON.stringify(compiledSource('src/shared/quit-teardown-deadline.ts'))})
  const supervision = load(${JSON.stringify(compiledSource('src/shared/serve-supervision.ts'))}, {
    './quit-teardown-deadline': deadline
  })
  const messages = load(${JSON.stringify(compiledSource('src/shared/serve-update-handoff.ts'))})
  const sender = load(${JSON.stringify(compiledSource('src/main/serve-update-handoff.ts'))}, {
    electron: { app: { getVersion: () => '1.4.181' } },
    './persistence': { getCanonicalUserDataPath: () => '/fixture' },
    '../shared/serve-supervision': supervision,
    '../shared/serve-update-handoff': messages
  })
  function quit() {
    sender.markServeUserQuit()
    sender.notifyServeSupervisorUserQuit(true, false)
      .then(() => {
        if (process.env.ORCA_QUIT_FIXTURE_HANG === '1') setInterval(() => {}, 1000)
        else process.exit(0)
      }, () => process.exit(1))
  }
  process.on('message', (message) => {
    if (message === 'quit') quit()
  })
  if (process.env.ORCA_QUIT_FIXTURE_READY === '1') {
    sender.notifyServeSupervisorReady('runtime-ready', {
      websocket: 'ready', runtime: 'ready', graph: 'ready'
    })
  } else quit()
  `
}

describe('foreground serve user quit over IPC', () => {
  it('bounds a committed user quit that never exits without spawning a replacement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const childEnv = {
      ...process.env,
      [SERVE_SUPERVISOR_ENV]: '1',
      ORCA_QUIT_FIXTURE_READY: '0',
      ORCA_QUIT_FIXTURE_HANG: '1'
    }
    for (const key of ['HOME', 'CODEX_HOME']) {
      expect(key in childEnv).toBe(key in process.env)
      expect(childEnv[key]).toBe(process.env[key])
    }
    const child = spawn(process.execPath, ['-e', childSource()], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    const closed = once(child, 'close')
    const message = once(child, 'message')
    let childStderr = ''
    child.stderr?.on('data', (chunk) => {
      childStderr += String(chunk)
    })
    const kill = vi.spyOn(child, 'kill')
    const spawnChild = vi.fn()
    const sleep = vi.fn(async () => undefined)
    const result = superviseForegroundServe({
      child,
      executable: process.execPath,
      childArgs: [],
      spawnOptions: {},
      spawnChild,
      handoffPath: null,
      expectedHandoff: null,
      sleep
    })
    try {
      const firstMessage = await Promise.race([
        message,
        closed.then((exit) => {
          throw new Error(`Fixture exited before IPC: ${exit}; ${childStderr}`)
        })
      ])
      expect(firstMessage[0]).toEqual({ type: 'orca:serve-user-quit' })
      await vi.advanceTimersByTimeAsync(SERVE_SUPERVISED_SHUTDOWN_GRACE_MS - 1)
      expect(kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(kill).toHaveBeenCalledWith('SIGKILL')
      expect(await closed).toEqual([null, 'SIGKILL'])
      await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
      expect(spawnChild).not.toHaveBeenCalled()
      expect(sleep).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      await closed
      await result
      vi.restoreAllMocks()
    }
  }, 5_000)

  it.each([false, true])(
    'stops after production user quit IPC (ready=%s) and clean exit',
    async (ready) => {
      const childEnv = {
        ...process.env,
        [SERVE_SUPERVISOR_ENV]: '1',
        ORCA_QUIT_FIXTURE_READY: ready ? '1' : '0'
      }
      for (const key of ['HOME', 'CODEX_HOME']) {
        expect(key in childEnv).toBe(key in process.env)
        expect(childEnv[key]).toBe(process.env[key])
      }
      const child = spawn(process.execPath, ['-e', childSource()], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
      const closed = once(child, 'close')
      const healthProbe = vi.fn(async () => ({
        healthy: true as const,
        runtimeId: 'runtime-ready'
      }))
      const spawnChild = vi.fn(() => {
        throw new Error('User quit must not launch a replacement')
      })
      const sleep = vi.fn(async () => undefined)
      try {
        const result = superviseForegroundServe({
          child,
          executable: process.execPath,
          childArgs: [],
          spawnOptions: {},
          spawnChild,
          handoffPath: null,
          expectedHandoff: null,
          healthProbe,
          sleep,
          restartDelaysMs: [1],
          healthCheckIntervalMs: 60_000
        })
        if (ready) {
          await vi.waitFor(() => expect(healthProbe).toHaveBeenCalledOnce())
          await new Promise<void>((resolve, reject) => {
            child.send('quit', (error) => (error ? reject(error) : resolve()))
          })
        }

        await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
        expect(await closed).toEqual([0, null])
        expect(spawnChild).not.toHaveBeenCalled()
        expect(sleep).not.toHaveBeenCalled()
        if (!ready) {
          expect(healthProbe).not.toHaveBeenCalled()
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        await closed
      }
    },
    5_000
  )
})
