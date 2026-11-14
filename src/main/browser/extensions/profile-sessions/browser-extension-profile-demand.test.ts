import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireBrowserExtensionProfileDemand,
  attachBrowserExtensionProfileDemand,
  detachBrowserExtensionProfileDemand,
  retainBrowserExtensionPage,
  trackBrowserExtensionTargetReadiness
} from './browser-extension-profile-demand'
import { setBrowserExtensionSupportEnabled } from '../browser-extension-support'

vi.mock('../../sessions/profiles/browser-session-profile-identity', () => ({
  getBrowserSessionProfileIdentity: (session: { id: string }) => session.id
}))
const attached: string[] = []
function attach(id: string, activate: () => Promise<void>, suspend: () => Promise<void>): void {
  attached.push(id)
  attachBrowserExtensionProfileDemand(id, activate, suspend, () => ['extension'])
}
function page(id: string): Electron.WebContents & EventEmitter {
  const contents = new EventEmitter()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
  return Object.assign(contents, {
    session: { id },
    isDestroyed: () => false
  }) as unknown as Electron.WebContents & EventEmitter
}
afterEach(() => {
  for (const id of attached.splice(0)) {
    detachBrowserExtensionProfileDemand(id)
  }
})

describe('browser profile execution demand', () => {
  it.each([750, 7500])(
    'keeps %i unused profiles cold; one actual profile activates once',
    async (count) => {
      setBrowserExtensionSupportEnabled(true)
      const starts: string[] = []
      const stops: string[] = []
      for (let i = 0; i < count; i++) {
        const id = `profile-${i}`
        attach(
          id,
          async () => {
            starts.push(id)
          },
          async () => {
            stops.push(id)
          }
        )
      }
      // Output requires one activation for the one demanded profile, independent of saved count.
      expect(starts).toEqual([])
      const first = page('profile-3')
      const second = page('profile-3')
      await retainBrowserExtensionPage(first)
      await retainBrowserExtensionPage(second)
      expect(starts).toEqual(['profile-3'])
      first.emit('destroyed')
      expect(stops).toEqual([])
      second.emit('destroyed')
      expect(stops).toEqual(['profile-3'])
      const reopened = page('profile-3')
      await retainBrowserExtensionPage(reopened)
      expect(starts).toEqual(['profile-3', 'profile-3'])
      reopened.emit('destroyed')
    }
  )

  it('keeps an explicit action alive across transfer to an actual page', async () => {
    setBrowserExtensionSupportEnabled(true)
    const stopped = vi.fn(async () => {})
    attach('options', async () => {}, stopped)
    const action = acquireBrowserExtensionProfileDemand('options', 'extension')!
    await action.ready
    const tab = page('options')
    await retainBrowserExtensionPage(tab)
    await action.release()
    expect(stopped).not.toHaveBeenCalled()
    tab.emit('destroyed')
    expect(stopped).toHaveBeenCalledTimes(1)
    await action.release()
    expect(stopped).toHaveBeenCalledTimes(1)
  })
})

it.each([5, 50])(
  'activates only a targeted operation among %i enabled extensions and preserves it across page expansion',
  async (count) => {
    setBrowserExtensionSupportEnabled(true)
    const ids = Array.from({ length: count }, (_, index) => `extension-${index}`)
    const started: string[] = []
    const stopped: string[] = []
    attached.push('targeted')
    attachBrowserExtensionProfileDemand(
      'targeted',
      async (id) => {
        started.push(id)
      },
      async (id) => {
        stopped.push(id)
      },
      () => ids
    )
    const first = acquireBrowserExtensionProfileDemand('targeted', ids[0])!
    const overlap = acquireBrowserExtensionProfileDemand('targeted', ids[0])!
    await first.ready
    expect(started).toEqual(['extension-0'])
    const tab = page('targeted')
    await retainBrowserExtensionPage(tab)
    expect(started).toEqual(ids)
    tab.emit('destroyed')
    expect(stopped).toEqual(ids.slice(1))
    await first.release()
    expect(stopped).toEqual(ids.slice(1))
    await overlap.release()
    expect(stopped).toEqual([...ids.slice(1), 'extension-0'])
  }
)

it('keeps pending initial intent through a replacement readiness owner and dispatches it once', async () => {
  const { navigateBrowserExtensionPage } = await import('./browser-extension-page-navigation')
  setBrowserExtensionSupportEnabled(true)
  let release!: () => void
  const oldReady = new Promise<void>((resolve) => {
    release = resolve
  })
  attach(
    'intent',
    () => oldReady,
    async () => {}
  )
  const tab = page('intent')
  const navigate = vi.fn(async () => {})
  const navigation = navigateBrowserExtensionPage(tab, navigate)
  trackBrowserExtensionTargetReadiness('intent', 'extension', Promise.resolve())
  await navigation
  expect(navigate).toHaveBeenCalledOnce()
  release()
  await oldReady
  await Promise.resolve()
  expect(navigate).toHaveBeenCalledOnce()
  tab.emit('destroyed')
})

it('does not replay the staged URL after a newer programmatic main-frame navigation', async () => {
  const { navigateBrowserExtensionPage } = await import('./browser-extension-page-navigation')
  setBrowserExtensionSupportEnabled(true)
  let release!: () => void
  attach(
    'superseded-intent',
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
    async () => {}
  )
  const tab = page('superseded-intent')
  const navigate = vi.fn(async () => {})
  const navigation = navigateBrowserExtensionPage(tab, navigate)
  tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await navigation
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(navigate).not.toHaveBeenCalled()
  tab.emit('destroyed')
})
