import { BrowserRoutePageAvailability } from './browser-route-page-availability'
import { describe, expect, it, vi } from 'vitest'
import {
  createCommand,
  createHarness,
  createLifecycleClaim
} from './browser-client-page-command-executor-test-harness'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'

const switchCommand = (): BrowserClientHostCommandEvent =>
  createCommand('navigate', {
    pageReconciliationProtocolVersion: 1,
    command: {
      type: 'switchProfile',
      nextPageHostGeneration: 8,
      profile: {
        id: 'remote-isolated',
        label: 'Remote profile',
        scope: 'isolated'
      }
    }
  })

async function fixture(
  availability?: BrowserRoutePageAvailability,
  oldGuestIsCurrent?: () => boolean
) {
  const harness = createHarness()
  if (oldGuestIsCurrent) {
    harness.dependencies.routeWebContents.claimGuestLifecycle.mockImplementationOnce(
      (registration) => createLifecycleClaim(registration, Promise.resolve(), oldGuestIsCurrent)
    )
  }
  if (availability) {
    Object.assign(harness.dependencies.routeWebContents, {
      watchPageAvailability: availability.watch
    })
  }
  const bindReplacement = vi.fn()
  Object.assign(harness.dependencies.guestBinding, { bindReplacement })
  await harness.executor.handle(createCommand('createPage'), new AbortController().signal)
  harness.dependencies.routeSessions.preparePage.mockResolvedValue({
    partition: `persist:orca-browser-v1-${'b'.repeat(64)}`,
    release: vi.fn()
  })
  harness.renderer.mountPage.mockResolvedValue({ webContentsId: 42 })
  harness.order.length = 0
  return { ...harness, bindReplacement }
}

describe('staged client page profile switching', () => {
  it('prepares a separate partition and guest before retiring the authenticated old guest', async () => {
    const h = await fixture()
    let retired = false
    h.dependencies.routeWebContents.beginGuestRetirement.mockImplementation(() => {
      retired = true
      expect(h.bindReplacement).toHaveBeenCalledWith(
        expect.objectContaining({
          registration: expect.objectContaining({
            webContentsId: 42,
            pageHostGeneration: 8
          })
        })
      )
      return Promise.resolve()
    })
    h.bindReplacement.mockImplementation(() => expect(retired).toBe(false))
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toEqual({
      status: 'completed'
    })
    expect(h.executor.hasPage('page-a', 8)).toBe(true)
    expect(h.executor.hasPage('page-a', 7)).toBe(false)
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      { browserProfileId: 'remote-isolated', pageHostGeneration: 8 }
    ])
    expect(h.dependencies.routeSessions.preparePage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          browserProfileId: 'remote-isolated',
          authorityConnectionIdentity: 'authority-record-a'
        }),
        profileMetadata: {
          id: 'remote-isolated',
          label: 'Remote profile',
          scope: 'isolated'
        }
      })
    )
  })

  it('preserves the old guest when target preparation fails', async () => {
    const h = await fixture()
    h.dependencies.routeSessions.preparePage.mockRejectedValueOnce(
      new Error('target profile rejected')
    )
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed'
    })
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    expect(h.dependencies.routeWebContents.beginGuestRetirement).not.toHaveBeenCalled()
    expect(h.bindReplacement).not.toHaveBeenCalled()
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      { browserProfileId: 'profile-a', state: 'active' }
    ])
  })

  it('retires only the staged guest and restores the old binding when binding fails', async () => {
    const h = await fixture()
    h.bindReplacement.mockImplementation(() => {
      throw new Error('bind failed')
    })
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed'
    })
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    expect(h.dependencies.routeWebContents.beginGuestRetirement).toHaveBeenCalledTimes(1)
    expect(h.dependencies.routeWebContents.beginGuestRetirement).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ webContentsId: 42 })
      })
    )
    expect(h.dependencies.guestBinding.bind).toHaveBeenLastCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ webContentsId: 41 }),
        browserProfileId: 'profile-a'
      })
    )
  })

  it('restores the old guest when replacement navigation fails', async () => {
    const h = await fixture()
    await h.executor.handle(
      createCommand('navigate', {
        command: { type: 'navigate', url: 'https://example.com/authenticated' }
      }),
      new AbortController().signal
    )
    h.dependencies.routeWebContents.navigateGuest.mockResolvedValueOnce(false)
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed'
    })
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      {
        browserProfileId: 'profile-a',
        currentUrl: 'https://example.com/authenticated',
        state: 'active'
      }
    ])
    expect(h.dependencies.guestBinding.bind).toHaveBeenLastCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ webContentsId: 41 })
      })
    )
    const binding = h.dependencies.guestBinding
    const stagedRelease = binding.release.mock.calls.findIndex(
      ([registration]) => registration.webContentsId === 42
    )
    expect(binding.bind.mock.invocationCallOrder.at(-1)).toBeLessThan(
      binding.release.mock.invocationCallOrder[stagedRelease]!
    )
  })

  it('rejects a target partition collision without retiring the old guest', async () => {
    const h = await fixture()
    h.dependencies.routeSessions.preparePage.mockResolvedValueOnce(h.routeSession)
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed',
      errorCode: 'browser_client_page_profile_partition_conflict'
    })
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    expect(h.bindReplacement).not.toHaveBeenCalled()
    expect(h.dependencies.routeWebContents.beginGuestRetirement).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ webContentsId: 42 })
      })
    )
  })

  it('keeps the new availability watcher after retiring the old generation', async () => {
    const availability = new BrowserRoutePageAvailability()
    const h = await fixture(availability)
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'completed'
    })
    availability.report(h.dependencies.routeWebContents.claimGuestLifecycle.mock.calls[0]![0])
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      { state: 'active', pageHostGeneration: 8 }
    ])
    availability.report(h.dependencies.routeWebContents.claimGuestLifecycle.mock.calls.at(-1)![0])
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      { state: 'outcomeUnknown', pageHostGeneration: 8 }
    ])
  })

  it('retains unresolved staged cleanup evidence without replacing the old page', async () => {
    const h = await fixture()
    h.bindReplacement.mockImplementation(() => {
      throw new Error('bind failed')
    })
    h.dependencies.routeWebContents.beginGuestRetirement.mockImplementationOnce(() => {
      throw new Error('cleanup refused')
    })
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed'
    })
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    await expect(h.executor.close()).rejects.toThrow('Browser client page executor cleanup failed')
  })

  it('fences the staged guest when the connection is fenced during automation retirement', async () => {
    const h = await fixture()
    await h.executor.handle(
      createCommand('navigate', {
        command: { type: 'navigate', url: 'https://example.com/authenticated' }
      }),
      new AbortController().signal
    )
    h.dependencies.routeWebContents.navigateGuest.mockClear()
    h.dependencies.retireAutomation.mockImplementationOnce(async () => {
      h.executor.fenceNavigation()
    })
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })
    expect(h.dependencies.routeWebContents.revokeNavigation).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ webContentsId: 42 })
      })
    )
    expect(h.dependencies.routeWebContents.navigateGuest).not.toHaveBeenCalled()
    expect(h.bindReplacement).not.toHaveBeenCalled()
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
  })

  it('keeps cleanup evidence when staging fails before handing over its guest', async () => {
    const h = await fixture()
    h.dependencies.routeWebContents.registerGuest.mockReturnValueOnce(false)
    h.dependencies.routeWebContents.beginGuestRetirement.mockImplementationOnce(() => {
      throw new Error('cleanup refused')
    })
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed',
      errorCode: 'browser_client_page_cleanup_failed'
    })
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    await expect(h.executor.close()).rejects.toThrow('Browser client page executor cleanup failed')
  })

  it('does not commit a replacement guest that died before the switch finished', async () => {
    const h = await fixture()
    let replacementAlive = true
    h.dependencies.routeWebContents.claimGuestLifecycle.mockImplementationOnce((registration) =>
      createLifecycleClaim(registration, Promise.resolve(), () => replacementAlive)
    )
    h.bindReplacement.mockImplementation(() => {
      replacementAlive = false
    })
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed',
      errorCode: 'browser_client_page_generation_stale'
    })
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    expect(h.dependencies.routeWebContents.beginGuestRetirement).toHaveBeenCalledTimes(1)
    expect(h.dependencies.routeWebContents.beginGuestRetirement).toHaveBeenCalledWith(
      expect.objectContaining({ registration: expect.objectContaining({ webContentsId: 42 }) })
    )
  })

  it('reports an old guest lost during a failed switch so recovery can run', async () => {
    let oldAlive = true
    const availability = new BrowserRoutePageAvailability()
    const h = await fixture(availability, () => oldAlive)
    const onPageUnavailable = vi.fn()
    Object.assign(h.dependencies, { onPageUnavailable })
    h.dependencies.routeSessions.preparePage.mockImplementationOnce(async () => {
      oldAlive = false
      availability.report(h.dependencies.routeWebContents.claimGuestLifecycle.mock.calls[0]![0])
      throw new Error('target profile rejected')
    })
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toMatchObject({
      status: 'failed'
    })
    expect(onPageUnavailable).toHaveBeenCalledWith('page-a', 7)
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      { pageHostGeneration: 7, state: 'outcomeUnknown' }
    ])
    expect(h.dependencies.guestBinding.bind).toHaveBeenCalledTimes(1)
  })

  it('lets the staged guest own downloads it starts while loading the page', async () => {
    const h = await fixture()
    await h.executor.handle(
      createCommand('navigate', {
        command: { type: 'navigate', url: 'https://example.com/report.csv' }
      }),
      new AbortController().signal
    )
    let owner: { pageHostGeneration: number } | undefined
    h.dependencies.routeWebContents.navigateGuest.mockImplementationOnce(async () => {
      owner = h.executor.findPageByWebContentsId(42)
      return true
    })
    expect(await h.executor.handle(switchCommand(), new AbortController().signal)).toEqual({
      status: 'completed'
    })
    expect(owner).toMatchObject({ browserPageId: 'page-a', pageHostGeneration: 8 })
  })

  it('rejects stale generations without preparing or binding anything', async () => {
    const h = await fixture()
    const calls = h.dependencies.routeSessions.preparePage.mock.calls.length
    expect(
      await h.executor.handle(
        { ...switchCommand(), pageHostGeneration: 6 },
        new AbortController().signal
      )
    ).toMatchObject({ status: 'failed' })
    expect(h.dependencies.routeSessions.preparePage).toHaveBeenCalledTimes(calls)
    expect(h.bindReplacement).not.toHaveBeenCalled()
  })

  it('rolls back an abort after successful target binding', async () => {
    const h = await fixture()
    const controller = new AbortController()
    h.bindReplacement.mockImplementation(() => controller.abort())
    expect(await h.executor.handle(switchCommand(), controller.signal)).toMatchObject({
      status: 'failed'
    })
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    expect(h.dependencies.guestBinding.bind).toHaveBeenLastCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ webContentsId: 41 })
      })
    )
  })
})
