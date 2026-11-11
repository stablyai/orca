import { afterEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { spawnCodexAppServerConnection } from '../codex/app-server/codex-app-server-connection'
import { proveClaudeChildExit } from '../claude/claude-agent-sdk-exit-proof'
import {
  findSelfInitiatedTreeKills,
  resetSelfInitiatedTreeKillLogForTest
} from '../crash-reporting/self-initiated-tree-kill-log'
import { spawnManagedProviderProcess } from './managed-provider-process'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: vi.fn(
    (_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) =>
      callback(null)
  )
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers()
  resetSelfInitiatedTreeKillLogForTest()
})

it('attributes forced Windows child closes to their owning agent and path', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.useFakeTimers()
  resetSelfInitiatedTreeKillLogForTest()
  const codexChild = createFakePipedChild(424242)
  const codex = await spawnCodexAppServerConnection(
    { command: 'codex', args: ['app-server'] },
    {},
    () => codexChild
  )
  const claudeChild = createFakePipedChild(424243)
  const claude = spawnManagedProviderProcess(
    { command: 'claude', args: [] },
    { spawnImpl: () => claudeChild, site: 'claude-stream-json-teardown' }
  )
  const closes = Promise.all([codex.close(), proveClaudeChildExit({ managed: claude })])
  await vi.runAllTimersAsync()
  await closes

  expect(findSelfInitiatedTreeKills(Date.now())).toEqual([
    {
      pid: 424242,
      site: 'codex-app-server-child-close',
      scope: 'win-taskkill-tree',
      at: expect.any(Number)
    },
    {
      pid: 424243,
      site: 'claude-structured-child-close',
      scope: 'win-taskkill-tree',
      at: expect.any(Number)
    }
  ])
})
