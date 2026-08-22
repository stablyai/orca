import { describe, expect, it, vi } from 'vitest'
import { releaseOwnedEndpoint } from './relay-owned-endpoint-release'

function recorder(): { steps: string[]; step: (name: string) => () => void } {
  const steps: string[] = []
  return { steps, step: (name: string) => () => steps.push(name) }
}

describe('releaseOwnedEndpoint', () => {
  it('removes the manifest before it closes the server or unlinks the socket', () => {
    // Why: a bound socket is what excludes a successor. Once the pathname is free a successor can
    // bind it and publish its own manifest, and any removal landing after that can only delete the
    // successor's file.
    const { steps, step } = recorder()

    const released = releaseOwnedEndpoint({
      ownsPath: () => true,
      removeManifest: step('removeManifest'),
      closeServer: step('closeServer'),
      unlinkSocket: step('unlinkSocket')
    })

    expect(released).toBe(true)
    expect(steps).toEqual(['removeManifest', 'closeServer', 'unlinkSocket'])
  })

  it('does nothing at all when the path is no longer owned', () => {
    const removeManifest = vi.fn()
    const closeServer = vi.fn()
    const unlinkSocket = vi.fn()

    const released = releaseOwnedEndpoint({
      ownsPath: () => false,
      removeManifest,
      closeServer,
      unlinkSocket
    })

    expect(released).toBe(false)
    expect(removeManifest).not.toHaveBeenCalled()
    expect(closeServer).not.toHaveBeenCalled()
    expect(unlinkSocket).not.toHaveBeenCalled()
  })

  it('still releases the socket when this generation published no manifest', () => {
    const { steps, step } = recorder()

    releaseOwnedEndpoint({
      ownsPath: () => true,
      removeManifest: null,
      closeServer: step('closeServer'),
      unlinkSocket: step('unlinkSocket')
    })

    expect(steps).toEqual(['closeServer', 'unlinkSocket'])
  })

  it('unlinks the socket when there is no server to close', () => {
    const { steps, step } = recorder()

    releaseOwnedEndpoint({
      ownsPath: () => true,
      removeManifest: step('removeManifest'),
      closeServer: null,
      unlinkSocket: step('unlinkSocket')
    })

    expect(steps).toEqual(['removeManifest', 'unlinkSocket'])
  })

  it('attempts the manifest removal at most once across repeated calls', () => {
    // Why: the caller drops ownership after a release, so a later shutdown or uncaughtException
    // handler must not issue a second removal — by then the pathname may belong to a successor.
    const removeManifest = vi.fn()
    let owned = true
    const steps = {
      ownsPath: () => owned,
      removeManifest,
      closeServer: () => {
        owned = false
      },
      unlinkSocket: () => {}
    }

    releaseOwnedEndpoint(steps)
    releaseOwnedEndpoint(steps)

    expect(removeManifest).toHaveBeenCalledTimes(1)
  })

  it('releases the socket even when the manifest removal throws', () => {
    const { steps, step } = recorder()

    expect(() =>
      releaseOwnedEndpoint({
        ownsPath: () => true,
        removeManifest: () => {
          throw new Error('manifest gone')
        },
        closeServer: step('closeServer'),
        unlinkSocket: step('unlinkSocket')
      })
    ).not.toThrow()
    expect(steps).toEqual(['closeServer', 'unlinkSocket'])
  })
})
