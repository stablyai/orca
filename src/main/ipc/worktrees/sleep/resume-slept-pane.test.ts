import { beforeEach, expect, it, vi } from 'vitest'
import { ipcRenderer } from 'electron'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import type { WorktreeApi } from '../../../../preload/api/worktree-api'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler)
  },
  ipcRenderer: {
    invoke: async (name: string, ...args: unknown[]) => handlers.get(name)?.({}, ...args)
  }
}))
import { registerWorktreeSleepHandlers } from './register-worktree-sleep-handlers'
import { worktreesApi } from '../../../../preload/api/worktrees-bridge'

beforeEach(() => handlers.clear())

it('validates the bundled bridge argument before the runtime receives any trigger authority', async () => {
  const resumeSleptPane = vi.fn(async () => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only runtime; this test invokes only resumeSleptPane.
  registerWorktreeSleepHandlers({ runtime: { resumeSleptPane } } as unknown as WorktreeIpcContext)
  const pane = { worktreeId: 'wt', tabId: 'tab', leafId: 'leaf' }
  const bridge: WorktreeApi = worktreesApi
  await expect(bridge.resumeSleptPane(pane)).resolves.toBe(true)
  for (const automatic of [undefined, false, true]) {
    await expect(bridge.resumeSleptPane(pane, automatic)).resolves.toBe(true)
    expect(resumeSleptPane).toHaveBeenLastCalledWith(pane, automatic)
  }
  resumeSleptPane.mockClear()
  for (const invalid of [
    null,
    0,
    1,
    'true',
    [],
    {},
    { automatic: true, targetsHost: true, targetGroupId: 'g' }
  ]) {
    await expect(ipcRenderer.invoke('worktrees:resumeSleptPane', pane, invalid)).rejects.toThrow(
      'invalid_automatic'
    )
  }
  await expect(
    ipcRenderer.invoke('worktrees:resumeSleptPane', { tabId: 'tab' }, true)
  ).rejects.toThrow('invalid_pane')
  expect(resumeSleptPane).not.toHaveBeenCalled()
})
