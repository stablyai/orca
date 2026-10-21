import { describe, expect, it } from 'vitest'
import {
  browser,
  closeChildren,
  enablePopupFixtureNativeControls,
  guest,
  origin,
  receipts,
  setPopupFixtureEvidenceName,
  snapshots,
  status
} from './browser-popup-compatibility-cdp-fixture'
import {
  clickBackgroundPopupProbe,
  comparableBackgroundReceipt,
  observeBackgroundPopupProbe,
  prepareBackgroundPopupProbe,
  refreshBackgroundPopupStatus,
  type BackgroundPopupProbe
} from './browser-popup-background-cdp-probe'

enablePopupFixtureNativeControls()
setPopupFixtureEvidenceName('background-electron-evidence.json')

describe('hidden Chromium background OpenURL compatibility', () => {
  it.each(
    (['local', 'route'] as const).flatMap((name) =>
      (['same-origin', 'cross-site', 'no-referrer', 'subframe', 'opaque'] as const).map(
        (context) => ({ name, context })
      )
    )
  )(
    'matches native modifier GET and POST controls across initiating contexts: $name/$context',
    async ({ name, context }) => {
      const page = guest(name)
      const targetOrigin = origin.replace('127.0.0.1', 'localhost')
      await page
        .locator('#shift')
        .evaluate((link, url) => link.setAttribute('href', url), `${targetOrigin}/seed`)
      await page.locator('#shift').click({ modifiers: ['Shift'] })
      await expect
        .poll(() =>
          browser
            ?.contexts()
            .flatMap((context) => context.pages())
            .some((child) => child.url() === `${targetOrigin}/seed`)
        )
        .toBe(true)
      const seed = browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((child) => child.url() === `${targetOrigin}/seed`)
      expect(await seed?.evaluate('document.cookie')).toContain('strict_cookie=synthetic')
      await closeChildren(page)
      for (const [kind, input] of [
        ['link', 'middle'],
        ['link', 'modifier'],
        ['post', 'modifier'],
        ['empty', 'modifier'],
        ['multipart', 'modifier']
      ] as const) {
        const probe = { context, kind, input }
        const control = await observeBackgroundPopupProbe(name, probe, true)
        const production = await observeBackgroundPopupProbe(name, probe, false)
        if (!control) {
          throw new Error('Missing native control receipt')
        }
        expect(control).toMatchObject({
          method: kind === 'link' ? 'GET' : 'POST',
          origin:
            kind === 'link'
              ? ''
              : context === 'opaque' || context === 'no-referrer'
                ? 'null'
                : origin,
          fetchSite: context === 'same-origin' ? 'same-origin' : 'cross-site',
          fetchMode: 'navigate',
          fetchDest: 'document',
          fetchUser: '?1',
          cookie: context === 'same-origin' ? `synthetic_session=${name}` : '',
          proxied: name === 'route',
          body:
            kind === 'empty' || kind === 'link'
              ? ''
              : kind === 'post'
                ? 'code=synthetic%2Bvalue'
                : expect.stringContaining('synthetic+value')
        })
        if (name === 'local' && kind === 'link') {
          expect(production).toBeNull()
        } else {
          if (!production) {
            throw new Error('Missing production receipt')
          }
          expect(comparableBackgroundReceipt(production)).toEqual(
            comparableBackgroundReceipt(control)
          )
        }
      }
      expect(status().native.presentationCalls).toEqual([])
      expect(status().windowsHidden).toBe(true)
    },
    60_000
  )

  it.each(['authority', 'authority-error', 'webrtc', 'close'])(
    'blocks the first background POST request when creation fails: %s',
    async (failure) => {
      const page = guest('route')
      const probe: BackgroundPopupProbe = {
        kind: 'post',
        context: 'same-origin',
        input: 'modifier'
      }
      await prepareBackgroundPopupProbe(page, probe, `${origin}/must-not-execute-background`)
      await page.evaluate((failure) => console.log(`orca-popup-fixture:fail-${failure}`), failure)
      await refreshBackgroundPopupStatus()
      const before = status().native.windows.length
      const receiptCount = receipts.length
      await clickBackgroundPopupProbe(page, probe)
      await refreshBackgroundPopupStatus()
      await expect.poll(() => status().native.windows.length).toBe(before + 1)
      await expect.poll(() => status().native.windows.at(-1)?.closed).toBe(true)
      expect(
        receipts
          .slice(receiptCount)
          .some((receipt) => receipt.path === '/must-not-execute-background')
      ).toBe(false)
      expect(status().native.presentationCalls).toEqual([])
      snapshots.push(status())
      await page.evaluate('console.log("orca-popup-fixture:restore-authority")')
    }
  )

  it('keeps the cap, close accounting, descendant gate, fence, regrant and parent teardown for background children', async () => {
    const page = guest('route')
    const probe: BackgroundPopupProbe = { kind: 'link', context: 'same-origin', input: 'middle' }
    await prepareBackgroundPopupProbe(page, probe, `${origin}/background-owned`)
    const children = () =>
      browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .filter((child) => child.url() === `${origin}/background-owned`) ?? []
    for (let count = 1; count <= 4; count += 1) {
      await clickBackgroundPopupProbe(page, probe)
      await expect.poll(() => children().length).toBe(count)
    }
    const receiptCount = receipts.length
    const blocked = status().blocked.length
    await clickBackgroundPopupProbe(page, probe)
    await expect.poll(() => status().blocked.length).toBe(blocked + 1)
    expect(
      receipts.slice(receiptCount).some((receipt) => receipt.path === '/background-owned')
    ).toBe(false)
    const child = children()[0]
    if (!child) {
      throw new Error('Missing owned background child')
    }
    expect(await child.evaluate('window.open("about:blank")===null')).toBe(true)
    await child.evaluate('window.close()')
    await expect.poll(() => child.isClosed()).toBe(true)
    await clickBackgroundPopupProbe(page, probe)
    await expect.poll(() => children().length).toBe(4)
    const fenced = children()
    await page.evaluate('console.log("orca-popup-fixture:fence")')
    await expect.poll(() => status().routeGranted).toBe(false)
    await expect.poll(() => fenced.every((child) => child.isClosed())).toBe(true)
    const fencedReceiptCount = receipts.length
    const fencedBlocked = status().blocked.length
    await clickBackgroundPopupProbe(page, probe)
    await expect.poll(() => status().blocked.length).toBe(fencedBlocked + 1)
    expect(
      receipts.slice(fencedReceiptCount).some((receipt) => receipt.path === '/background-owned')
    ).toBe(false)
    await page.evaluate('console.log("orca-popup-fixture:grant")')
    await expect.poll(() => status().routeGranted).toBe(true)
    await clickBackgroundPopupProbe(page, probe)
    await expect.poll(() => children().length).toBe(1)
    const regranted = children()[0]
    await page.evaluate('console.log("orca-popup-fixture:close")')
    await expect.poll(() => regranted.isClosed()).toBe(true)
    expect(status().native.presentationCalls).toEqual([])
    expect(status().windowsHidden).toBe(true)
    snapshots.push(status())
  })
})
