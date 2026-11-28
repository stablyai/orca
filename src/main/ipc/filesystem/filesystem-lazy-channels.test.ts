import { beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import type * as LazyIpcHandleGroup from '../lazy-ipc-handle-group'

type Listener = (event: unknown, ...args: unknown[]) => unknown

type Group = { channels: readonly string[]; load: (ipc: unknown) => Promise<void> }

const { handlers, groups } = vi.hoisted(() => {
  const groups: Group[] = []
  return { handlers: new Map<string, Listener>(), groups }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-test', on: vi.fn(), isPackaged: false },
  shell: {},
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, listener)
    },
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

vi.mock('../lazy-ipc-handle-group', async (importOriginal) => {
  const actual = await importOriginal<typeof LazyIpcHandleGroup>()
  return {
    ...actual,
    registerLazyIpcHandleGroup: (
      channels: readonly string[],
      load: (ipc: unknown) => Promise<void>
    ) => {
      groups.push({ channels, load })
      actual.registerLazyIpcHandleGroup(channels, load)
    }
  }
})

const event = { sender: { id: 1, once: vi.fn(), isDestroyed: () => false } }

beforeEach(async () => {
  handlers.clear()
  groups.length = 0
  const { registerFilesystemHandlers } = await import('./filesystem')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration and the SSH-rejecting search path never read the store.
  registerFilesystemHandlers({} as Store)
})

it('serves content search and its cancel on first invoke, before any file listing', async () => {
  await expect(handlers.get('fs:cancelSearch')!(event, { requestToken: 't' })).resolves.toBe(
    undefined
  )
  await expect(
    handlers.get('fs:search')!(event, { rootPath: '/repo', query: 'x', connectionId: 'ssh-1' })
  ).rejects.toMatchObject({ code: 'ssh_host_not_served' })
})

it('installs every lazily loaded channel only through its own group entry point', async () => {
  const eager = new Set(handlers.keys())
  for (const { channels, load } of groups) {
    const registered: string[] = []
    await load({ handle: (channel: string) => registered.push(channel) })
    expect(registered.sort()).toEqual([...channels].sort())
  }
  expect(new Set(handlers.keys())).toEqual(eager)
})
