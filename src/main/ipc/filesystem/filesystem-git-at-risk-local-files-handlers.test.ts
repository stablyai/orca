import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSenderScopedRequestCancellations } from '../sender-scoped-request-cancellation'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

const { handlers, readAtRiskMock } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, args: unknown) => unknown>(),
  readAtRiskMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../providers/execution-host-provider-dispatch', () => ({
  requireReachableGitRoute: vi.fn()
}))
vi.mock('./wsl-gated-worktree-git-read', () => ({
  readWorktreeGitUnlessWslStopped: (
    _store: unknown,
    worktreePath: string,
    _wake: unknown,
    read: (path: string, gitOptions: { wslDistro?: string }) => Promise<unknown>
  ) => read(worktreePath, { wslDistro: undefined })
}))
vi.mock('../local-worktree-runtime-options', () => ({
  getLocalRepoForRegisteredWorktree: vi.fn(() => ({ path: '/repo' }))
}))
vi.mock('../../git/worktrees/removal/worktree-at-risk-local-files', () => ({
  readWorktreeAtRiskLocalFiles: readAtRiskMock
}))

import { registerFilesystemGitAtRiskLocalFilesHandlers } from './filesystem-git-at-risk-local-files-handlers'

function requestEvent(id = 1): IpcMainInvokeEvent {
  const sender = Object.assign(new EventEmitter(), { id })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cancellation registry only reads sender.id and its EventEmitter lifetime methods.
  return { sender } as unknown as IpcMainInvokeEvent
}

function invoke(channel: string, event: IpcMainInvokeEvent, args: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler(event, args)
}

describe('git:atRiskLocalFiles cancellation', () => {
  beforeEach(() => {
    handlers.clear()
    readAtRiskMock.mockReset()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only read store and the git status cancellation registry.
    const context = {
      store: {},
      gitStatusCancellations: createSenderScopedRequestCancellations()
    } as unknown as FilesystemHandlerContext
    registerFilesystemGitAtRiskLocalFilesHandlers(context)
  })

  it('aborts the scan when the renderer cancels its request token', async () => {
    let scanSignal: AbortSignal | undefined
    readAtRiskMock.mockImplementation(
      (args: { gitOptions?: { signal?: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          scanSignal = args.gitOptions?.signal
          scanSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    const event = requestEvent()

    const scan = invoke('git:atRiskLocalFiles', event, {
      worktreePath: '/repo-feature',
      requestToken: 'at-risk-1'
    })
    await vi.waitFor(() => expect(readAtRiskMock).toHaveBeenCalled())
    expect(scanSignal?.aborted).toBe(false)

    await invoke('git:cancelAtRiskLocalFiles', event, {
      requestToken: 'at-risk-1'
    })

    expect(scanSignal?.aborted).toBe(true)
    await expect(scan).rejects.toThrow('aborted')
  })

  it('does not let another window cancel the scan', async () => {
    let scanSignal: AbortSignal | undefined
    readAtRiskMock.mockImplementation((args: { gitOptions?: { signal?: AbortSignal } }) => {
      scanSignal = args.gitOptions?.signal
      return Promise.resolve({ count: 0, samplePaths: [], complete: true })
    })

    void invoke('git:atRiskLocalFiles', requestEvent(1), {
      worktreePath: '/repo-feature',
      requestToken: 'at-risk-1'
    })
    await vi.waitFor(() => expect(readAtRiskMock).toHaveBeenCalled())
    await invoke('git:cancelAtRiskLocalFiles', requestEvent(2), {
      requestToken: 'at-risk-1'
    })

    expect(scanSignal?.aborted).toBe(false)
  })
})
