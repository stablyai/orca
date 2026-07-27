import { describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { routeSshFilesystemWatchNotification } from './ssh-filesystem-watch-notifications'
import type { WatchRegistration } from './ssh-filesystem-provider-watch'

function registration(rootPath: string, ...callbacks: ((events: FsChangeEvent[]) => void)[]) {
  return {
    rootPath,
    callbacks: new Set(callbacks),
    terminalCallbacks: new Map(),
    remoteWatchId: 1,
    ready: true,
    stopping: false,
    unwatchSent: false
  } as unknown as WatchRegistration
}

function changed(...paths: string[]): FsChangeEvent[] {
  return paths.map((absolutePath) => ({ kind: 'update', absolutePath }) as FsChangeEvent)
}

function route(registrations: Map<string, WatchRegistration>, events: FsChangeEvent[]): void {
  routeSshFilesystemWatchNotification(registrations, 'fs.changed', { events })
}

// Reference: the pre-change routing, which called isPathInsideOrEqual per pair and
// so re-normalized the candidate for every root. Not circular for what this asserts
// -- the change under test is that one shared normalization of each candidate still
// matches every root the per-pair normalization did.
function referenceRoute(roots: string[], events: FsChangeEvent[]): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const rootPath of roots) {
    const matching = events.filter((event) => isPathInsideOrEqual(rootPath, event.absolutePath))
    if (matching.length > 0) {
      result[rootPath] = matching.map((event) => event.absolutePath)
    }
  }
  return result
}

describe('routeSshFilesystemWatchNotification fs.changed fan-out', () => {
  it('delivers only the events inside each root', () => {
    const alpha = vi.fn()
    const beta = vi.fn()
    const registrations = new Map([
      ['/repo/alpha', registration('/repo/alpha', alpha)],
      ['/repo/beta', registration('/repo/beta', beta)]
    ])

    route(
      registrations,
      changed(
        '/repo/alpha/src/a.ts',
        '/repo/beta/src/b.ts',
        '/repo/alpha/src/c.ts',
        '/elsewhere/d.ts'
      )
    )

    expect(alpha).toHaveBeenCalledTimes(1)
    expect(alpha.mock.calls[0][0].map((event: FsChangeEvent) => event.absolutePath)).toEqual([
      '/repo/alpha/src/a.ts',
      '/repo/alpha/src/c.ts'
    ])
    expect(beta.mock.calls[0][0].map((event: FsChangeEvent) => event.absolutePath)).toEqual([
      '/repo/beta/src/b.ts'
    ])
  })

  // Why: the fix hoists normalization out of the inner loop, so the risk is that a
  // shared pre-normalized candidate stops matching a root it used to match.
  it('routes identically to per-pair normalization', () => {
    const roots = ['/repo/alpha', '/repo/alpha-extra', '/repo/beta/', '/repo']
    const events = changed(
      '/repo/alpha/src/a.ts',
      '/repo/alpha-extra/src/b.ts',
      '/repo/beta/src/c.ts',
      '/repo/alpha',
      '/repo//alpha//src//d.ts',
      '/repo/gamma/e.ts',
      '/elsewhere/f.ts'
    )
    const seen: Record<string, string[]> = {}
    const registrations = new Map(
      roots.map((rootPath) => [
        rootPath,
        registration(rootPath, (delivered) => {
          seen[rootPath] = delivered.map((event) => event.absolutePath)
        })
      ])
    )

    route(registrations, events)

    expect(seen).toEqual(referenceRoute(roots, events))
  })

  // Why: normalizeRuntimePathForComparison is not idempotent for WSL UNC paths, so
  // a candidate normalized once up front must still match a root normalized once.
  it('matches WSL UNC roots whose case survives only a single fold', () => {
    const received = vi.fn()
    const registrations = new Map([
      ['wsl', registration('\\\\wsl.localhost\\Ubuntu\\home\\User\\Repo', received)]
    ])

    route(registrations, changed('//wsl$/UBUNTU/home/User/Repo/src/a.ts'))

    expect(received).toHaveBeenCalledTimes(1)
    expect(received.mock.calls[0][0][0].absolutePath).toBe('//wsl$/UBUNTU/home/User/Repo/src/a.ts')
  })

  // Why: macOS emits NFD names while stored roots are often NFC; both spell the
  // same directory, and the shared candidate must still fold into the root.
  it('matches a root recorded in NFC against NFD event paths', () => {
    const received = vi.fn()
    const registrations = new Map([['nfc', registration('/repo/café'.normalize('NFC'), received)]])

    route(registrations, changed('/repo/café/src/a.ts'.normalize('NFD')))

    expect(received).toHaveBeenCalledTimes(1)
  })

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    const received = vi.fn()
    const registrations = new Map([['alpha', registration('/repo/alpha', received)]])

    route(registrations, changed('/repo/alphabet/src/a.ts'))

    expect(received).not.toHaveBeenCalled()
  })

  it('delivers the root itself to a watcher on that root', () => {
    const received = vi.fn()
    const registrations = new Map([['alpha', registration('/repo/alpha', received)]])

    route(registrations, changed('/repo/alpha'))

    expect(received).toHaveBeenCalledTimes(1)
  })

  it('notifies every callback registered on a shared root', () => {
    const first = vi.fn()
    const second = vi.fn()
    const registrations = new Map([['alpha', registration('/repo/alpha', first, second)]])

    route(registrations, changed('/repo/alpha/src/a.ts'))

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('skips callbacks entirely when no event is inside the root', () => {
    const received = vi.fn()
    const registrations = new Map([['alpha', registration('/repo/alpha', received)]])

    route(registrations, changed('/elsewhere/a.ts', '/repo/beta/b.ts'))

    expect(received).not.toHaveBeenCalled()
  })

  it('ignores methods other than fs.changed and fs.watchFailed', () => {
    const received = vi.fn()
    const registrations = new Map([['alpha', registration('/repo/alpha', received)]])

    routeSshFilesystemWatchNotification(registrations, 'pty.data', {
      events: changed('/repo/alpha/src/a.ts')
    })

    expect(received).not.toHaveBeenCalled()
  })
})
