import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const resolved: string[] = []
  const programs: string[] = []
  return { resolved, programs }
})

vi.mock('@orca/process-host', () => ({
  spawnProcess: (spec: { program: string }) => {
    state.programs.push(spec.program)
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      kill: vi.fn()
    })
    queueMicrotask(() =>
      spec.program.startsWith('/proc/')
        ? child.emit(
            'error',
            Object.assign(new Error(`spawn ${spec.program} ENOENT`), { code: 'ENOENT' })
          )
        : child.emit('close', 0)
    )
    return child
  }
}))
vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: () => state.resolved.shift() ?? '/home/me/.local/bin/claude'
}))

import { runClaudeCommandProcess } from './claude-command-process'

const WINDOWS_ONLY = '/proc/orca-agent-cli-installed-only-on-windows/claude'
const config = { windowsPath: '/home/me/.claude', linuxPath: null, wslDistro: null }
const originalPlatform = process.platform
afterEach(() => {
  state.resolved.length = 0
  state.programs.length = 0
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

it('says Claude is installed only on Windows instead of a raw spawn ENOENT', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  state.resolved.push(WINDOWS_ONLY, WINDOWS_ONLY, WINDOWS_ONLY)
  await expect(runClaudeCommandProcess(['auth', 'status'], config, 1000)).rejects.toThrow(
    'Claude is installed only on Windows, not in this WSL distro. Install it inside the distro.'
  )
})

it('never keeps the Windows-only answer, so a Claude installed in WSL since is used', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  // The first lookup sees only the Windows copy; every later one finds the new WSL install.
  state.resolved.push(WINDOWS_ONLY)
  await expect(runClaudeCommandProcess(['auth', 'status'], config, 1000)).rejects.toThrow(
    'installed only on Windows'
  )
  await runClaudeCommandProcess(['auth', 'status'], config, 1000)
  expect(state.programs).toEqual([WINDOWS_ONLY, '/home/me/.local/bin/claude'])
})
