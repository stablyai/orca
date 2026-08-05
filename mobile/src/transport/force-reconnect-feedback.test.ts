import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forceReconnectErrorPresentation,
  showForceReconnectError,
  startForceReconnectWithFeedback
} from './force-reconnect-feedback'

const alert = vi.hoisted(() => vi.fn())

vi.mock('react-native', () => ({ Alert: { alert } }))

describe('forceReconnectErrorPresentation', () => {
  it('explains that recovery continues after an application-health timeout', () => {
    expect(forceReconnectErrorPresentation(new Error('Request timed out: worktree.ps'))).toEqual({
      title: "Desktop still isn't responding",
      message:
        'Orca opened a new connection, but the desktop did not respond within 15 seconds. Orca will keep retrying automatically.'
    })
  })

  it('turns a replacement-open failure into a concrete next step', () => {
    expect(
      forceReconnectErrorPresentation(new Error('Unable to open a replacement connection'))
    ).toEqual({
      title: "Couldn't reconnect to desktop",
      message: 'Make sure desktop Orca is open and both devices are online, then try again.'
    })
  })

  it('explains how to recover an invalid pairing', () => {
    expect(
      forceReconnectErrorPresentation(new Error('Unauthorized — pairing may be revoked'))
    ).toMatchObject({ title: 'Pairing no longer works' })
  })
})

describe('showForceReconnectError', () => {
  beforeEach(() => alert.mockReset())

  it('offers a retry when the caller can repeat the action', () => {
    const retry = vi.fn()
    showForceReconnectError(new Error('Request timed out: worktree.ps'), retry)

    expect(alert).toHaveBeenCalledWith(
      "Desktop still isn't responding",
      expect.stringContaining('keep retrying automatically'),
      [
        { text: 'Dismiss', style: 'cancel' },
        { text: 'Try again', onPress: retry }
      ]
    )
  })

  it('never exposes an unknown internal error', () => {
    showForceReconnectError(new Error('secure store exploded'))

    expect(alert).toHaveBeenCalledWith(
      "Couldn't reconnect to desktop",
      expect.not.stringContaining('secure store'),
      [{ text: 'Dismiss', style: 'cancel' }]
    )
  })

  it('repeats the same reconnect action from Try again', async () => {
    const reconnect = vi.fn().mockRejectedValue(new Error('connection failed'))
    startForceReconnectWithFeedback(reconnect)
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce())

    const buttons = alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[]
    buttons.find((button) => button.text === 'Try again')?.onPress?.()
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(2))
  })
})
