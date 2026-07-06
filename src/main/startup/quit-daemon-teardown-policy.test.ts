import { describe, expect, it } from 'vitest'
import { shouldShutdownDaemonForQuit } from './quit-daemon-teardown-policy'

describe('shouldShutdownDaemonForQuit', () => {
  it('keeps the daemon alive for normal quits', () => {
    expect(
      shouldShutdownDaemonForQuit({
        isDevParentShutdownRequested: false,
        isQuittingForUpdate: false
      })
    ).toBe(false)
  })

  it('keeps the daemon alive for updater installs', () => {
    expect(
      shouldShutdownDaemonForQuit({
        isDevParentShutdownRequested: false,
        isQuittingForUpdate: true
      })
    ).toBe(false)
  })

  it('shuts down the daemon when a dev parent is going away', () => {
    expect(
      shouldShutdownDaemonForQuit({
        isDevParentShutdownRequested: true,
        isQuittingForUpdate: false
      })
    ).toBe(true)
  })
})
