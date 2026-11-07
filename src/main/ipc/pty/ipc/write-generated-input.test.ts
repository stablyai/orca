import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GeneratedAgentInputNotices } from '../../../runtime/generated-agent-input-notices'
import type { PtyRendererDelivery } from '../session'
import { ptyOwnership } from '../provider/ownership-state'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  provider: { hasPty: () => true, write: vi.fn<(id: string, data: string) => boolean>() }
}))
vi.mock('../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    on: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      h.handlers.set(channel, handler),
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      h.handlers.set(channel, handler),
    removeHandler: (channel: string) => h.handlers.delete(channel),
    removeAllListeners: vi.fn()
  })
}))
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: () => h.provider }))

const { installPtyWriteIpcHandlers } = await import('./write')

const webContents = {
  id: 7,
  isDestroyed: () => false,
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}
const mainWindow: PtyRendererDelivery = {
  isDestroyed: () => false,
  isFocused: () => true,
  isVisible: () => true,
  isMinimized: () => false,
  webContents
}

function setUp(claimRemoteDesktopHost: () => Promise<boolean> = async () => true) {
  const notices = new GeneratedAgentInputNotices()
  installPtyWriteIpcHandlers({
    mainWindow,
    runtime: {
      generatedInputNotices: notices,
      claimRemoteDesktopHost,
      getDriver: () => ({ kind: 'idle' }),
      noteRemoteDesktopHostInput: vi.fn()
    } as never
  })
  notices.upsert({
    id: 'op',
    origin: 'desktop-window:7',
    pending: true,
    text: 'exact',
    agent: 'claude',
    certainty: 'not-sent',
    handle: '',
    worktreeId: '',
    ptyId: 'pty'
  })
  const writeAccepted = (data: string) =>
    Promise.resolve(
      h.handlers.get('pty:writeAccepted')!(
        { sender: webContents },
        { id: 'pty', data, inputKind: 'launch', generatedInputOperationId: 'op' }
      )
    )
  return { writeAccepted, certainty: () => notices.noticeOf('op')?.certainty }
}

beforeEach(() => {
  h.handlers.clear()
  h.provider.write.mockReset()
  ptyOwnership.set('pty', 'local')
})
afterEach(() => {
  ptyOwnership.delete('pty')
})

// XR2 legacy local/SSH route: an accepted request is possibly sent only from its bytes' handoff to
// the terminal's provider, and only a refusal before any frame may have been taken proves it
// unsent. Main settles it with no renderer involved.
it('settles a local write of an accepted request at its provider handoff', async () => {
  const { writeAccepted, certainty } = setUp()
  h.provider.write.mockReturnValueOnce(false)
  await expect(writeAccepted('first')).resolves.toBe(false)
  expect(certainty()).toBe('not-sent')
  h.provider.write.mockReturnValueOnce(true)
  await expect(writeAccepted('second')).resolves.toBe(true)
  expect(certainty()).toBe('unconfirmed')
  h.provider.write.mockReturnValueOnce(false)
  await expect(writeAccepted('third')).resolves.toBe(false)
  expect(certainty()).toBe('unconfirmed')
})

// A write held behind the pane's viewport claim has not reached the terminal yet.
it('is not sent while a viewport claim still holds its write', async () => {
  let release!: (claimed: boolean) => void
  const { writeAccepted, certainty } = setUp(
    () => new Promise<boolean>((resolve) => (release = resolve))
  )
  h.handlers.get('pty:claimViewport')!({ sender: webContents }, { id: 'pty', cols: 80, rows: 24 })
  h.provider.write.mockReturnValueOnce(true)
  const written = writeAccepted('held')
  expect(certainty()).toBe('not-sent')
  expect(h.provider.write).not.toHaveBeenCalled()
  release(true)
  await expect(written).resolves.toBe(true)
  expect(certainty()).toBe('unconfirmed')
})
