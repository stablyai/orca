import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const spawned = vi.hoisted((): { program: string; args: string[] }[] => [])
vi.mock('../../shared/child-process/run-process', () => ({
  spawnProcess: (options: { program: string; args: string[] }) => {
    spawned.push(options)
    const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() })
    setTimeout(() => taskkill.emit('close', 0), 0)
    return taskkill
  }
}))
vi.mock('../own-chromium-tree-kill-guard', () => ({ admitSelfInitiatedTreeKill: () => true }))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))

import { terminateClaudeProcess } from './claude-login-process-termination'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  spawned.length = 0
})

it('cancels a Windows login by ending its whole process tree with taskkill', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const child = { pid: 4242, kill: vi.fn() }
  const afterKill = vi.fn()
  terminateClaudeProcess(child, null, afterKill)
  await vi.waitFor(() => expect(afterKill).toHaveBeenCalledOnce())
  expect(spawned).toEqual([
    expect.objectContaining({ program: 'taskkill.exe', args: ['/pid', '4242', '/t', '/f'] })
  ])
  expect(child.kill).not.toHaveBeenCalled()
})

it('cancels a Windows login through the relayed login PID, not the wrapper', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const child = { pid: 1, kill: vi.fn() }
  const afterKill = vi.fn()
  terminateClaudeProcess(child, { waitForTerminationPid: async () => 777 }, afterKill)
  await vi.waitFor(() => expect(afterKill).toHaveBeenCalledOnce())
  expect(spawned[0]?.args).toEqual(['/pid', '777', '/t', '/f'])
})
