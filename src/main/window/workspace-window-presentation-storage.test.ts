import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  handle: vi.fn(),
  identity: vi.fn(() => 'window-a')
}))
vi.mock('electron', () => ({ ipcMain: { on: mocks.on, handle: mocks.handle } }))
vi.mock('./workspace-window-native-bridge', () => ({
  getWorkspaceWindowNavigationId: mocks.identity
}))
import { registerWorkspaceWindowPresentationStorage } from './workspace-window-presentation-storage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.identity.mockReturnValue('window-a')
})

it('authorizes native flushes and propagates durable write failure', async () => {
  let rejectWrite!: (error: Error) => void
  const flushPendingOrThrowAsync = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectWrite = reject
      })
  )
  registerWorkspaceWindowPresentationStorage(() => ({ flushPendingOrThrowAsync }) as never)
  const handler = mocks.handle.mock.calls[0][1]
  const pending = handler({})
  expect(flushPendingOrThrowAsync).toHaveBeenCalledOnce()
  rejectWrite(new Error('disk full'))
  await expect(pending).rejects.toThrow('Native presentation checkpoint failed')
  mocks.identity.mockImplementation(() => {
    throw new Error('unauthorized')
  })
  await expect(handler({})).rejects.toThrow('unauthorized')
  expect(flushPendingOrThrowAsync).toHaveBeenCalledOnce()
})
it('uses authorized window identity and refuses arbitrary or unauthorized storage keys', () => {
  const setWorkspaceWindowPresentation = vi.fn()
  const getWorkspaceWindowPresentation = vi.fn(() => 'saved')
  registerWorkspaceWindowPresentationStorage(
    () => ({ setWorkspaceWindowPresentation, getWorkspaceWindowPresentation }) as never
  )
  const handler = mocks.on.mock.calls[0][1]
  const event = { returnValue: undefined }
  handler(
    event,
    'orca.web.ui.v1',
    JSON.stringify({ activeView: 'terminal', browserKagiSessionLink: 'private-session-link' })
  )
  expect(setWorkspaceWindowPresentation).toHaveBeenCalledWith(
    'window-a',
    'orca.web.ui.v1',
    JSON.stringify({ activeView: 'terminal' })
  )
  mocks.identity.mockReturnValue('window-b')
  handler(event, 'orca.web.ui.v1')
  expect(getWorkspaceWindowPresentation).toHaveBeenLastCalledWith('window-b', 'orca.web.ui.v1')
  handler(event, 'orca.web.runtimeEnvironment.v1', 'credential')
  expect(event.returnValue).toHaveProperty('error')
  expect(setWorkspaceWindowPresentation).toHaveBeenCalledTimes(1)
  mocks.identity.mockImplementation(() => {
    throw new Error('unauthorized')
  })
  handler(event, 'orca.web.ui.v1', 'overwrite')
  expect(setWorkspaceWindowPresentation).toHaveBeenCalledTimes(1)
})
