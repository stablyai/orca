import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import type * as ProcessHostModule from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import { killRecipeProcess } from '../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-process'
import { killLocalPrecheckProcessTree } from '../../automations/dispatch/precheck-runner'
import { terminateClaudeProcess } from '../../claude-accounts/sign-in/claude-login-process-termination'
import { killCodexAppServerProcessTree } from '../../codex/app-server/codex-app-server-process-tree-kill'
import { killSourceControlAgentProcess } from '../../text-generation/execution/source-control-agent-termination'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) }
})
vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHostModule>()
  return { ...actual, spawnProcess: vi.fn(actual.spawnProcess) }
})

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

const stopSites: [string, (child: ChildProcessWithoutNullStreams) => unknown][] = [
  ['automation precheck', (child) => killLocalPrecheckProcessTree(child)],
  ['Codex app-server', (child) => killCodexAppServerProcessTree(child)],
  ['ephemeral VM recipe', (child) => killRecipeProcess(child, true)],
  [
    'Claude account login',
    (child) => new Promise<void>((resolve) => terminateClaudeProcess(child, null, resolve))
  ],
  ['source-control text generation', (child) => killSourceControlAgentProcess(child)]
]

// Windows can hand an exited root's pid to an unrelated process before close fires.
it.each(stopSites)(
  '%s does not taskkill the pid of a root that already exited',
  async (_, stop) => {
    const child = spawn(process.execPath, ['-e', ''])
    await once(child, 'exit')
    vi.mocked(spawn).mockClear()
    vi.mocked(execFile).mockClear()
    vi.mocked(spawnProcess).mockClear()
    Object.defineProperty(process, 'platform', { value: 'win32' })

    await stop(child)

    expect(spawn).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
    expect(spawnProcess).not.toHaveBeenCalled()
  }
)
