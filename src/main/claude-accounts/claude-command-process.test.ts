import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

type SpawnSpec = { program: string; args?: readonly string[]; env?: NodeJS.ProcessEnv }
const spawned = vi.hoisted(() => {
  const specs: SpawnSpec[] = []
  return { specs }
})

vi.mock('@orca/process-host', () => ({
  spawnProcess: (spec: SpawnSpec) => {
    spawned.specs.push(spec)
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      kill: vi.fn()
    })
    queueMicrotask(() => child.emit('close', 0))
    return child
  }
}))
vi.mock('../codex-cli/command', () => ({ resolveClaudeCommand: () => 'claude' }))
vi.mock('../wsl/wsl-executable-path', () => ({
  resolveWslExecutablePath: () => 'C:\\Windows\\System32\\wsl.exe'
}))

import { buildWslLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { runClaudeCommandProcess } from './claude-command-process'

const originalPlatform = process.platform
afterEach(() => {
  spawned.specs.length = 0
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('runClaudeCommandProcess', () => {
  it("logs in on the host with CLAUDE_CONFIG_DIR set to the account's folder", async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await runClaudeCommandProcess(
      ['auth', 'login', '--claudeai'],
      { windowsPath: '/data/claude-profiles/a/home', linuxPath: null, wslDistro: null },
      1000
    )
    expect(spawned.specs[0]).toMatchObject({
      program: 'claude',
      args: ['auth', 'login', '--claudeai']
    })
    expect(spawned.specs[0].env?.CLAUDE_CONFIG_DIR).toBe('/data/claude-profiles/a/home')
  })

  it("logs in through the distro's login shell with --exec for a WSL account", async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await runClaudeCommandProcess(
      ['auth', 'login', '--claudeai'],
      {
        windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\a',
        linuxPath: "/home/u/it's/a",
        wslDistro: 'Ubuntu'
      },
      1000
    )
    const spec = spawned.specs[0]
    expect(spec.program).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(spec.args?.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c'])
    expect(spec.args?.[5]).toBe(
      buildWslLoginShellCommand(
        `exec env CLAUDE_CONFIG_DIR='/home/u/it'\\''s/a' claude 'auth' 'login' '--claudeai'`
      )
    )
    expect(spec.env?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR)
  })

  it('hands BROWSER to a host login', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await runClaudeCommandProcess(
      ['auth', 'login', '--claudeai'],
      { windowsPath: '/data/a/home', linuxPath: null, wslDistro: null },
      1000,
      { browser: '/data/a/home/.orca-sign-in-browser' }
    )
    expect(spawned.specs[0].env?.BROWSER).toBe('/data/a/home/.orca-sign-in-browser')
  })

  it('makes the BROWSER helper executable inside the distro before a WSL login', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await runClaudeCommandProcess(
      ['auth', 'login', '--claudeai'],
      {
        windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\a',
        linuxPath: '/home/u/a',
        wslDistro: 'Ubuntu'
      },
      1000,
      { browser: '/home/u/a/.orca-sign-in-browser' }
    )
    expect(spawned.specs[0].args?.[5]).toBe(
      buildWslLoginShellCommand(
        `chmod 700 '/home/u/a/.orca-sign-in-browser'; exec env CLAUDE_CONFIG_DIR='/home/u/a' BROWSER='/home/u/a/.orca-sign-in-browser' claude 'auth' 'login' '--claudeai'`
      )
    )
  })
})
