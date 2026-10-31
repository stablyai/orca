import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from '../bind-first-pane.test-fixture'
import { OrcaRuntimeService, electronMocks, ipcMain } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../orca-runtime-test-scenario-builders.spec'

function makeHeadlessRuntime(runtimeStore: typeof store = store) {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-shell-pick' })
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn }
}

async function onHostPlatform(platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    await run()
  } finally {
    Object.defineProperty(process, 'platform', hostPlatform)
  }
}

const onWindowsHost = (run: () => Promise<void>) => onHostPlatform('win32', run)

describe('OrcaRuntimeService session-tab shell selection', () => {
  it('spawns the picked shell for a headless session terminal instead of typing it', async () => {
    await onWindowsHost(async () => {
      const { runtime, spawn } = makeHeadlessRuntime()

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        shellOverride: 'git-bash'
      })

      // Passing the shell as command typed git-bash into PowerShell instead of selecting it.
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ shellOverride: 'git-bash', command: undefined })
      )
    })
  })

  it('keeps the pick when a renderer-created tab is materialized after its surface stalls', async () => {
    await onWindowsHost(async () => {
      vi.useFakeTimers()
      try {
        const leafId = '44444444-4444-4444-8444-444444444444'
        const { runtime, spawn } = makeHeadlessRuntime()
        runtime.setNotifier(createMobileCreateTestNotifier(vi.fn()))
        const webContents = { send: vi.fn() }
        webContents.send = vi.fn((_channel: string, payload: { requestId: string }) => {
          ipcMain.emit(
            'terminal:tabCreateReply',
            { sender: webContents },
            { requestId: payload.requestId, tabId: 'tab-pending', title: 'Terminal' }
          )
        })
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
        electronMocks.BrowserWindow.fromId.mockReturnValue({
          isDestroyed: () => false,
          webContents
        })

        const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          shellOverride: 'cmd.exe'
        })
        await vi.waitFor(() => expect(webContents.send).toHaveBeenCalledTimes(1))
        expect(webContents.send.mock.calls[0]?.[1]).toMatchObject({ shellOverride: 'cmd.exe' })
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [
            {
              worktree: TEST_WORKTREE_ID,
              publicationEpoch: 'renderer-pending',
              snapshotVersion: 1,
              activeGroupId: 'group-1',
              activeTabId: `tab-pending::${leafId}`,
              activeTabType: 'terminal',
              tabs: [
                {
                  type: 'terminal',
                  id: `tab-pending::${leafId}`,
                  parentTabId: 'tab-pending',
                  leafId,
                  title: 'Terminal',
                  isActive: true
                }
              ]
            }
          ]
        })
        await vi.advanceTimersByTimeAsync(1_000)
        await create

        expect(spawn).toHaveBeenCalledWith(
          expect.objectContaining({ tabId: 'tab-pending', shellOverride: 'cmd.exe' })
        )
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('refuses a Windows shell on a POSIX host before any terminal exists', async () => {
    await onHostPlatform('linux', async () => {
      const { runtime, spawn } = makeHeadlessRuntime()

      await expect(
        runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, { shellOverride: 'cmd.exe' })
      ).rejects.toThrow(/names a Windows shell/)
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  it('refuses a shell pick for a workspace that runs over SSH', async () => {
    await onWindowsHost(async () => {
      const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
      const { runtime, spawn } = makeHeadlessRuntime({
        ...store,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
      })

      await expect(
        runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, { shellOverride: 'cmd.exe' })
      ).rejects.toThrow(/over SSH/)
      expect(spawn).not.toHaveBeenCalled()
    })
  })
})
