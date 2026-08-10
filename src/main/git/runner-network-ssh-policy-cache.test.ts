import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))

import { createGitNetworkSshPolicyCache } from './git-network-ssh-policy-cache'
import { gitExecFileAsync } from './runner'

function createMockChildProcess(): EventEmitter {
  return Object.assign(new EventEmitter(), { pid: 1234 })
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('runner network SSH policy cache', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('shares one SSH-policy probe across repeated calls in one operation', async () => {
    const child = createMockChildProcess()
    const calls: string[][] = []
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      calls.push(args)
      cb(null, args[0] === 'config' ? 'ssh -i ~/.ssh/work_key\n' : '', '')
      return child
    })
    const networkSshPolicyCache = createGitNetworkSshPolicyCache()

    for (const args of [
      ['ls-remote', 'upstream', 'HEAD'],
      ['fetch', 'upstream', 'main']
    ]) {
      await gitExecFileAsync(args, {
        cwd: '/repo',
        networkSshPolicyCache,
        useConfiguredSshCommandForNetwork: true
      })
    }

    expect(calls.filter((args) => args[0] === 'config')).toHaveLength(1)
  })

  it('coalesces concurrent SSH-policy probes for one host and repository', async () => {
    const child = createMockChildProcess()
    const calls: string[][] = []
    let finishProbe: ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      calls.push(args)
      if (args[0] === 'config') {
        finishProbe = cb
      } else {
        cb(null, '', '')
      }
      return child
    })
    const networkSshPolicyCache = createGitNetworkSshPolicyCache()
    const options = {
      cwd: '/repo',
      networkSshPolicyCache,
      useConfiguredSshCommandForNetwork: true
    }

    const first = gitExecFileAsync(['fetch', 'origin'], options)
    const second = gitExecFileAsync(['fetch', 'upstream'], options)
    expect(calls.filter((args) => args[0] === 'config')).toHaveLength(1)
    finishProbe?.(null, 'ssh -i ~/.ssh/work_key\n', '')
    await Promise.all([first, second])

    expect(calls.filter((args) => args[0] === 'config')).toHaveLength(1)
    expect(calls.filter((args) => args[0] === 'fetch')).toHaveLength(2)
  })

  it('isolates cached SSH policy by WSL execution host', async () => {
    await withPlatform('win32', async () => {
      const child = createMockChildProcess()
      const configDistros: string[] = []
      execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
        const shellCommand = args[5] as string
        if (shellCommand.includes("'config'")) {
          configDistros.push(args[1] as string)
          cb(null, 'ssh -i ~/.ssh/work_key\n', '')
        } else {
          cb(null, '', '')
        }
        return child
      })
      const networkSshPolicyCache = createGitNetworkSshPolicyCache()

      for (const wslDistro of ['Ubuntu', 'Debian']) {
        await gitExecFileAsync(['fetch', 'origin'], {
          cwd: String.raw`C:\repo`,
          networkSshPolicyCache,
          useConfiguredSshCommandForNetwork: true,
          wslDistro
        })
      }

      expect(configDistros).toEqual(['Ubuntu', 'Debian'])
    })
  })

  it('caches fallback policy within one operation and reprobes in the next', async () => {
    const child = createMockChildProcess()
    const configCalls: string[][] = []
    const fetchEnvs: NodeJS.ProcessEnv[] = []
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      if (args[0] === 'config') {
        configCalls.push(args)
        cb(Object.assign(new Error('missing'), { code: 1 }), '', '')
      } else {
        fetchEnvs.push(opts.env)
        cb(null, '', '')
      }
      return child
    })

    for (const networkSshPolicyCache of [
      createGitNetworkSshPolicyCache(),
      createGitNetworkSshPolicyCache()
    ]) {
      for (const remote of ['origin', 'upstream']) {
        await gitExecFileAsync(['fetch', remote], {
          cwd: '/repo',
          networkSshPolicyCache,
          useConfiguredSshCommandForNetwork: true
        })
      }
    }

    expect(configCalls).toHaveLength(2)
    expect(fetchEnvs).toHaveLength(4)
    expect(fetchEnvs.every((env) => env.GIT_SSH_COMMAND === 'ssh -o BatchMode=yes')).toBe(true)
  })
})
