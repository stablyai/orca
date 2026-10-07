import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProfileStateWriterError } from '../persistence/profile-state/profile-state-writer-errors'

const fixture = await vi.hoisted(async () => {
  const events = await import('node:events')
  const state: { isServeMode: boolean; isQuitting: boolean; mainWindow: unknown } = {
    isServeMode: false,
    isQuitting: false,
    mainWindow: null
  }
  return { show: vi.fn(), background: false, app: new events.EventEmitter(), state }
})
vi.mock('electron', () => ({ app: fixture.app, dialog: { showMessageBox: fixture.show } }))
vi.mock('../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => fixture.background
}))
vi.mock('./main-process-state', () => ({ mainProcessState: fixture.state }))
vi.mock('../persistence/profile-state/profile-state-writer-diagnostics', () => ({
  recordProfileStateWriteFailureReport: vi.fn()
}))

const { reportProfileStateWriteFailure } = await import('./profile-state-write-failure')
const { recordProfileStateWriteFailureReport } =
  await import('../persistence/profile-state/profile-state-writer-diagnostics')

class FakeWindow extends EventEmitter {
  visible: boolean
  destroyed = false
  readonly webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  readonly reveal = vi.fn()
  constructor(visible: boolean) {
    super()
    this.visible = visible
  }
  isVisible() {
    return this.visible
  }
  isDestroyed() {
    return this.destroyed
  }
  // Any of these would reveal or activate the app: the reporter must never call them.
  show = this.reveal
  showInactive = this.reveal
  focus = this.reveal
  moveTop = this.reveal
}

const timeout = new ProfileStateWriterError(
  'profile-state-writer-timeout',
  'timed out',
  'indeterminate'
)
const conflict = new ProfileStateWriterError(
  'profile-state-revision-conflict',
  'conflict',
  'known-failure'
)

beforeEach(() => {
  fixture.background = false
  fixture.state.isServeMode = false
  fixture.state.isQuitting = false
  fixture.state.mainWindow = null
  fixture.show.mockResolvedValue({ response: 0 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  // Release any reporter still waiting so module state does not leak between tests.
  fixture.state.isQuitting = true
  fixture.app.emit('browser-window-created', {}, new FakeWindow(false))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('attaches the alert to the visible main window and explains an unconfirmed write', async () => {
  const window = new FakeWindow(true)
  fixture.state.mainWindow = window
  reportProfileStateWriteFailure(timeout)
  await vi.waitFor(() => expect(fixture.show).toHaveBeenCalledOnce())
  expect(fixture.show).toHaveBeenCalledWith(window, {
    type: 'error',
    title: 'Saving stopped',
    message: 'Orca has stopped saving this profile.',
    detail:
      'Orca could not confirm whether your most recent change was saved. New changes will not be saved until you restart Orca.',
    buttons: ['OK']
  })
  expect(recordProfileStateWriteFailureReport).toHaveBeenCalledWith(timeout, 'dialog')
})

it('tells the user saved changes are safe when no write was left unresolved', async () => {
  fixture.state.mainWindow = new FakeWindow(true)
  reportProfileStateWriteFailure(conflict)
  await vi.waitFor(() => expect(fixture.show).toHaveBeenCalledOnce())
  expect(fixture.show.mock.calls[0][1]).toMatchObject({
    detail:
      'Changes saved before this point are safe. New changes will not be saved until you restart Orca.'
  })
})

it('waits for a hidden window to be shown by the user instead of revealing it', async () => {
  const window = new FakeWindow(false)
  fixture.state.mainWindow = window
  reportProfileStateWriteFailure(timeout)
  await new Promise((resolve) => setImmediate(resolve))
  expect(fixture.show).not.toHaveBeenCalled()
  expect(window.reveal).not.toHaveBeenCalled()
  expect(recordProfileStateWriteFailureReport).toHaveBeenCalledWith(timeout, 'deferred')
  window.visible = true
  window.emit('show')
  await vi.waitFor(() =>
    expect(fixture.show).toHaveBeenCalledExactlyOnceWith(window, expect.anything())
  )
})

it('never falls back to a parentless alert when no main window exists', async () => {
  reportProfileStateWriteFailure(timeout)
  await new Promise((resolve) => setImmediate(resolve))
  expect(fixture.show).not.toHaveBeenCalled()
  const window = new FakeWindow(true)
  fixture.app.emit('browser-window-created', {}, window)
  fixture.state.mainWindow = window
  await vi.waitFor(() =>
    expect(fixture.show).toHaveBeenCalledExactlyOnceWith(window, expect.anything())
  )
  for (const call of fixture.show.mock.calls) {
    expect(call).toHaveLength(2)
  }
})

it('waits for a replacement after the main window is destroyed', async () => {
  const destroyed = new FakeWindow(true)
  destroyed.destroyed = true
  fixture.state.mainWindow = destroyed
  reportProfileStateWriteFailure(timeout)
  await new Promise((resolve) => setImmediate(resolve))
  expect(fixture.show).not.toHaveBeenCalled()
  const replacement = new FakeWindow(true)
  fixture.state.mainWindow = replacement
  fixture.app.emit('browser-window-created', {}, replacement)
  await vi.waitFor(() =>
    expect(fixture.show).toHaveBeenCalledExactlyOnceWith(replacement, expect.anything())
  )
})

it('shows one alert for concurrent failures', async () => {
  fixture.state.mainWindow = new FakeWindow(true)
  let close!: () => void
  fixture.show.mockReturnValue(new Promise((resolve) => (close = () => resolve({ response: 0 }))))
  reportProfileStateWriteFailure(timeout)
  reportProfileStateWriteFailure(conflict)
  await vi.waitFor(() => expect(fixture.show).toHaveBeenCalledOnce())
  expect(recordProfileStateWriteFailureReport).toHaveBeenCalledWith(conflict, 'duplicate')
  close()
})

it.each(['background', 'serve'])('keeps %s runs free of native dialogs', async (mode) => {
  fixture.background = mode === 'background'
  fixture.state.isServeMode = mode === 'serve'
  fixture.state.mainWindow = new FakeWindow(true)
  reportProfileStateWriteFailure(timeout)
  await new Promise((resolve) => setImmediate(resolve))
  expect(fixture.show).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('stopped saving'),
    expect.any(Error)
  )
  expect(recordProfileStateWriteFailureReport).toHaveBeenCalledWith(timeout, 'suppressed')
})

it('handles a failed dialog without an unhandled rejection', async () => {
  fixture.state.mainWindow = new FakeWindow(true)
  fixture.show.mockRejectedValue(new Error('window system unavailable'))
  reportProfileStateWriteFailure(timeout)
  await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
})
