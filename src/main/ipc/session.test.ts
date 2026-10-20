import { describe, expect, it, vi } from 'vitest'

// Off path; switch-on test: session-window-view-save.test.ts › writes a paired server’s partition as the window sen...
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { returnValue?: unknown }, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: { returnValue?: unknown }, ...args: unknown[]) => unknown
      ) => {
        handlers.set(channel, handler)
      }
    ),
    on: vi.fn(
      (
        channel: string,
        handler: (event: { returnValue?: unknown }, ...args: unknown[]) => unknown
      ) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

import { registerSessionHandlers } from './session'

describe('registerSessionHandlers', () => {
  it('drops renderer writes to a fenced host source partition and keeps every other one', async () => {
    const store = {
      getSshTarget: vi.fn((id: string) =>
        id === 'fenced' ? { orcadFence: { environmentId: 'env-1' } } : {}
      ),
      setWorkspaceSession: vi.fn(),
      patchWorkspaceSession: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test touch only the store methods stubbed above and never the runtime.
    registerSessionHandlers(store as never, {} as never)

    for (const hostId of ['ssh:fenced', 'ssh:open', undefined]) {
      await handlers.get('session:set')?.({}, {}, hostId)
      await handlers.get('session:patch')?.({}, {}, hostId)
    }
    expect(store.setWorkspaceSession.mock.calls.map(([, hostId]) => hostId)).toEqual([
      'ssh:open',
      undefined
    ])
    expect(store.patchWorkspaceSession.mock.calls.map(([, hostId]) => hostId)).toEqual([
      'ssh:open',
      undefined
    ])
  })
})
