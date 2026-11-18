import type * as ChildProcessModule from 'node:child_process'
import type * as ProcessHostModule from '@orca/process-host'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const killers = vi.hoisted(() => ({
  spawn: vi.fn(),
  runProcess: vi.fn(async () => ({ code: 0 })),
  terminateWindowsProcessTree: vi.fn(async () => true),
  runWindowsTaskkillTree: vi.fn(async () => true)
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: killers.spawn
}))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHostModule>()),
  runProcess: killers.runProcess
}))
vi.mock('./windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: killers.terminateWindowsProcessTree,
  runWindowsTaskkillTree: killers.runWindowsTaskkillTree,
  windowsTaskkillTreeSpec: (pid: number) => ({ program: 'taskkill.exe', args: [String(pid)] })
}))
vi.mock('./own-chromium-tree-kill-guard', () => ({
  admitSelfInitiatedTreeKill: () => true
}))

import { killLocalPrecheckProcessTree } from '../../automations/dispatch/precheck-runner'
import { killCodexAppServerProcessTree } from '../../codex/app-server/codex-app-server-process-tree-kill'
import { killSourceControlAgentProcess } from '../../text-generation/execution/source-control-agent-termination'
import type { SpawnedSourceControlAgentProcess } from '../../text-generation/source-control-text-generation-types'

const hostPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  for (const killer of Object.values(killers)) {
    killer.mockClear()
  }
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
})

/** Exited, but a descendant still holds its pipes, so close has not arrived. */
function exitedRoot(): SpawnedSourceControlAgentProcess {
  const root: SpawnedSourceControlAgentProcess = Object.assign(new EventEmitter(), {
    // Outside any real process table, should a pid-addressed kill slip through.
    pid: 9_999_999,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(() => false),
    stdin: null,
    stdout: null,
    stderr: null
  })
  return root
}

function expectNoPidAddressedKill(): void {
  for (const killer of Object.values(killers)) {
    expect(killer).not.toHaveBeenCalled()
  }
}

it('stops a source-control agent whose root exited without a tree kill by its pid', async () => {
  await killSourceControlAgentProcess(exitedRoot())
  expectNoPidAddressedKill()
})

it('stops a Codex app-server whose root exited without a tree kill by its pid', () => {
  const spawnImpl = vi.fn()
  killCodexAppServerProcessTree(exitedRoot(), { platform: 'win32', spawnImpl })
  expect(spawnImpl).not.toHaveBeenCalled()
  expectNoPidAddressedKill()
})

it('times out an automation precheck whose root exited without a tree kill by its pid', () => {
  killLocalPrecheckProcessTree(exitedRoot())
  expectNoPidAddressedKill()
})
