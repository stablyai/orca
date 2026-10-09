import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))

import { gitExecFileAsync } from './runner'
import {
  GitAdmissionScheduler,
  _resetGitAdmissionForTests
} from './command-runner/git-subprocess-admission'

const originalPlatform = process.platform
const WSL_CWD = String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
const SSH_COMMAND = 'ssh -F /home/alice/.ssh/config'
const FETCH_ARGS = ['fetch', '--no-write-fetch-head', 'origin']

class ShellChild extends EventEmitter {
  readonly pid = 0
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kill = vi.fn()
}

type ShellCall = { script: string; env: NodeJS.ProcessEnv; child: ShellChild }

function installShell(
  options: { delayMs?: number; variant?: string; configError?: Error } = {}
): ShellCall[] {
  const calls: ShellCall[] = []
  execFileMock.mockImplementation((_program, args, spawnOptions, callback) => {
    const child = new ShellChild()
    const script = String(args.at(-1))
    calls.push({ script, env: spawnOptions.env, child })
    let closed = false
    const close = () => {
      if (closed) {
        return
      }
      closed = true
      child.emit('close', 0, null)
    }
    const reply = setTimeout(() => {
      const isProbe = script.includes("'config'")
      const payload = isProbe
        ? `core.sshcommand\n${SSH_COMMAND}\0ssh.variant\n${options.variant ?? 'ssh'}\0`
        : 'fetch-ok'
      const nonce = /__ORCA_WSL_CAPTURE_BEGIN_ ([^_]+)__/.exec(script)?.[1]
      const stdout = nonce
        ? `profile banner\n__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${payload}__ORCA_WSL_CAPTURE_END_${nonce}__`
        : payload
      callback(isProbe ? (options.configError ?? null) : null, stdout, '')
      close()
    }, options.delayMs ?? 3000)
    child.kill.mockImplementation(() => {
      clearTimeout(reply)
      queueMicrotask(close)
      return true
    })
    return child
  })
  return calls
}

function fetch(options: { timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}) {
  return gitExecFileAsync(FETCH_ARGS, {
    cwd: WSL_CWD,
    wslDistro: 'Ubuntu',
    env: {},
    ...options
  })
}

function networkCalls(calls: ShellCall[]): ShellCall[] {
  return calls.filter(({ script }) => script.includes("'fetch'"))
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  execFileMock.mockReset()
  _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetGitAdmissionForTests()
})

describe('WSL network Git SSH policy startup', () => {
  it('allows a three-second shell startup and preserves global config arguments', async () => {
    const calls = installShell()
    const args = ['-c', `core.sshCommand=${SSH_COMMAND}`, ...FETCH_ARGS]
    const pending = gitExecFileAsync(args, { cwd: WSL_CWD, wslDistro: 'Ubuntu', env: {} })

    await vi.advanceTimersByTimeAsync(6500)
    await expect(pending).resolves.toEqual({ stdout: 'fetch-ok', stderr: '' })
    expect(calls).toHaveLength(2)
    const probeScript = calls[0].script
    expect(probeScript).toContain(`core.sshCommand=${SSH_COMMAND}`)
    expect(probeScript.indexOf("'-c'")).toBeGreaterThan(-1)
    expect(probeScript.indexOf("'-c'")).toBeLessThan(probeScript.indexOf('core.sshCommand='))
    expect(probeScript.indexOf('core.sshCommand=')).toBeLessThan(probeScript.indexOf("'config'"))
    expect(calls[0].script).toContain('__ORCA_WSL_CAPTURE_BEGIN_')
    expect(calls[0].env.GIT_SSH_COMMAND).toBeUndefined()
    expect(networkCalls(calls)[0].env.GIT_SSH_COMMAND).toBe(
      SSH_COMMAND.replace('ssh', 'ssh -o BatchMode=yes')
    )
    expect(networkCalls(calls)[0].env.WSLENV?.split(':')).toContain('GIT_SSH_COMMAND')
  })

  it('honors an explicit shorter timeout before the network command starts', async () => {
    const calls = installShell()
    const pending = fetch({ timeout: 1000 }).catch((error) => error)

    await vi.advanceTimersByTimeAsync(1200)
    expect(await pending).toMatchObject({ message: 'wsl.exe timed out.' })
    expect(calls).toHaveLength(1)
    expect(calls[0].child.kill).toHaveBeenCalledOnce()
    expect(networkCalls(calls)).toHaveLength(0)
  })

  it.each([30_000, 0])('keeps the probe bounded with explicit timeout %s', async (timeout) => {
    const calls = installShell({ delayMs: 11_000 })
    const pending = fetch({ timeout }).catch((error) => error)

    await vi.advanceTimersByTimeAsync(10_500)
    expect(await pending).toMatchObject({ message: 'wsl.exe timed out.' })
    expect(calls[0].child.kill).toHaveBeenCalledOnce()
    expect(networkCalls(calls)).toHaveLength(0)
  })

  it.each([undefined, 0])('keeps the native probe deadline with timeout %s', async (timeout) => {
    const calls = installShell()
    const pending = gitExecFileAsync(FETCH_ARGS, { cwd: 'C:\\repo', env: {}, timeout }).catch(
      (error) => error
    )

    await vi.advanceTimersByTimeAsync(2700)
    expect(await pending).toMatchObject({ message: 'git timed out.' })
    expect(calls).toHaveLength(1)
    expect(calls[0].child.kill).toHaveBeenCalledOnce()
  })

  it('uses generic batch mode only when config reports a missing value', async () => {
    const calls = installShell({ configError: Object.assign(new Error('missing'), { code: 1 }) })
    const pending = fetch()

    await vi.advanceTimersByTimeAsync(6500)
    await expect(pending).resolves.toMatchObject({ stdout: 'fetch-ok' })
    expect(networkCalls(calls)[0].env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
  })

  it.each([128, 'ETIMEDOUT', 'ENOBUFS'])(
    'keeps configuration failure %s closed after a slow startup',
    async (code) => {
      const configError = Object.assign(new Error('WSL configuration unavailable'), { code })
      const calls = installShell({ configError })
      const pending = fetch().catch((error) => error)

      await vi.advanceTimersByTimeAsync(3500)
      expect(await pending).toBe(configError)
      expect(calls).toHaveLength(1)
      expect(networkCalls(calls)).toHaveLength(0)
    }
  )

  it.each(['simple', 'putty'])('preserves configured %s variant behavior', async (variant) => {
    const calls = installShell({ variant })
    const pending = fetch()

    await vi.advanceTimersByTimeAsync(6500)
    await expect(pending).resolves.toMatchObject({ stdout: 'fetch-ok' })
    expect(networkCalls(calls)).toHaveLength(1)
    expect(networkCalls(calls)[0].env.GIT_SSH_COMMAND).toBeUndefined()
  })

  it('aborts the slow probe and releases admission for the next attempt', async () => {
    const calls = installShell()
    const controller = new AbortController()
    const pending = fetch({ signal: controller.signal }).catch((error) => error)

    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(calls[0].child.kill).toHaveBeenCalledOnce()
    expect(networkCalls(calls)).toHaveLength(0)

    const retry = fetch()
    await vi.advanceTimersByTimeAsync(6500)
    await expect(retry).resolves.toMatchObject({ stdout: 'fetch-ok' })
    expect(networkCalls(calls)).toHaveLength(1)
  })

  it('does not spawn a probe for an already-aborted operation', async () => {
    const calls = installShell()
    const controller = new AbortController()
    controller.abort()

    await expect(fetch({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(0)
  })

  it('preserves explicitly forwarded SSH environment and skips the probe', async () => {
    const calls = installShell()
    const pending = fetch({ env: { GIT_SSH_COMMAND: SSH_COMMAND, WSLENV: 'GIT_SSH_COMMAND' } })

    await vi.advanceTimersByTimeAsync(3500)
    await expect(pending).resolves.toMatchObject({ stdout: 'fetch-ok' })
    expect(calls).toHaveLength(1)
    expect(networkCalls(calls)[0].env.GIT_SSH_COMMAND).toBe(SSH_COMMAND)
    expect(networkCalls(calls)[0].env.WSLENV?.split(':')).toContain('GIT_SSH_COMMAND')
  })
})
