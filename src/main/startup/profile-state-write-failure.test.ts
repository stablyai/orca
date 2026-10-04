import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { reportProfileStateWriteFailure } from './profile-state-write-failure'

const fixture = vi.hoisted(() => ({
  show: vi.fn(),
  background: false,
  state: { isServeMode: false }
}))
vi.mock('electron', () => ({ dialog: { showMessageBox: fixture.show } }))
vi.mock('../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => fixture.background
}))
vi.mock('./main-process-state', () => ({ mainProcessState: fixture.state }))

beforeEach(() => {
  fixture.background = false
  fixture.state.isServeMode = false
  fixture.show.mockResolvedValue({ response: 0 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('tells desktop users saving stopped without silently restarting the writer', () => {
  reportProfileStateWriteFailure(new Error('worker exited'))
  expect(fixture.show).toHaveBeenCalledExactlyOnceWith({
    type: 'error',
    title: 'Saving stopped',
    message: 'Orca has stopped saving this profile.',
    detail: 'Recent changes may not be saved. Restart Orca before continuing.',
    buttons: ['OK']
  })
})

it.each(['background', 'serve'])('keeps %s runs free of native dialogs', (mode) => {
  fixture.background = mode === 'background'
  fixture.state.isServeMode = mode === 'serve'
  reportProfileStateWriteFailure(new Error('worker exited'))
  expect(fixture.show).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('stopped saving'),
    expect.any(Error)
  )
})

it('handles a failed dialog without an unhandled rejection', async () => {
  fixture.show.mockRejectedValue(new Error('window system unavailable'))
  reportProfileStateWriteFailure(new Error('worker exited'))
  await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
})
