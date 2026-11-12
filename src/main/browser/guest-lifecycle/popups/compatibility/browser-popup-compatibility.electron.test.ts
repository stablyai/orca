import { describe, expect, it } from 'vitest'
import {
  browser,
  closeChildren,
  guest,
  origin,
  receipts,
  status
} from './browser-popup-compatibility-cdp-fixture'

describe('hidden Chromium popup compatibility', () => {
  it.each(['local', 'route'])(
    'keeps POST bodies, headers, referrers and cookie jars: %s',
    async (name) => {
      for (const id of ['post', 'multipart', 'empty']) {
        const before = receipts.length
        await guest(name).locator(`#${id}`).click()
        await expect
          .poll(() => receipts.slice(before).find((receipt) => receipt.path === `/${id}`))
          .toMatchObject({
            method: 'POST',
            referrer: `${origin}/${name}`,
            cookie: `synthetic_session=${name}`,
            proxied: name === 'route',
            origin,
            fetchSite: 'same-origin'
          })
        const receipt = receipts.slice(before).find((receipt) => receipt.path === `/${id}`)
        expect(receipt?.body).toEqual(
          id === 'post'
            ? 'code=synthetic%2Bvalue'
            : id === 'empty'
              ? ''
              : expect.stringContaining('synthetic-multipart')
        )
        expect(receipt?.contentType).toMatch(
          id === 'multipart'
            ? /^multipart\/form-data; boundary=/
            : /^application\/x-www-form-urlencoded/
        )
        await closeChildren(guest(name))
      }
    }
  )

  it('retains remote no-gesture, stale-gesture, scheme and four-window guards', async () => {
    const page = guest('route')
    expect(await page.evaluate('window.open("about:blank")===null')).toBe(true)
    await page.locator('#invalid').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('false')
    await page.locator('#stale').click()
    await expect
      .poll(() => page.locator('body').getAttribute('data-handle'), { timeout: 4_000 })
      .toBe('false')
    await page.locator('#burst').click()
    expect(await page.locator('body').getAttribute('data-handles')).toBe(
      '[true,false,false,false,false]'
    )
    await closeChildren(page)
    for (let index = 0; index < 3; index += 1) {
      await page.locator('#blank').click()
    }
    await page.locator('#shift').evaluate((link) => link.setAttribute('href', '/native-owned'))
    await page.locator('#shift').click({ modifiers: ['Shift'] })
    await expect
      .poll(() =>
        browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .some((candidate) => candidate.url() === `${origin}/native-owned`)
      )
      .toBe(true)
    const native = browser
      ?.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === `${origin}/native-owned`)
    if (!native) {
      throw new Error('Missing owned native child')
    }
    expect(await native.evaluate('window.open("about:blank")===null')).toBe(true)
    await page.evaluate('window.livePopup=window.popup')
    expect(await page.locator('body').getAttribute('data-handle')).toBe('true')
    await page.locator('#blank').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('false')
    expect(status().blocked.length).toBeGreaterThanOrEqual(7)
    expect(status().windowsHidden).toBe(true)
    expect(await page.evaluate('Notification.requestPermission()')).toBe('denied')
    await page.evaluate('console.log("orca-popup-fixture:fence")')
    await expect.poll(() => status().routeGranted).toBe(false)
    await expect.poll(() => page.evaluate('window.livePopup.closed')).toBe(true)
    await expect.poll(() => native.isClosed()).toBe(true)
    await page.locator('#blank').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('false')
    await page.evaluate('console.log("orca-popup-fixture:grant")')
    await expect.poll(() => status().routeGranted).toBe(true)
    await page.locator('#blank').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('true')
    const child = browser
      ?.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === 'about:blank#state')
    if (!child) {
      throw new Error('Missing child for opener-close check')
    }
    await page.locator('#shift').click({ modifiers: ['Shift'] })
    await expect
      .poll(() =>
        browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .some((candidate) => candidate.url() === `${origin}/native-owned`)
      )
      .toBe(true)
    const regrantedNative = browser
      ?.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === `${origin}/native-owned`)
    if (!regrantedNative) {
      throw new Error('Missing regranted native child')
    }
    await page.evaluate('console.log("orca-popup-fixture:close")')
    await expect.poll(() => child.isClosed()).toBe(true)
    await expect.poll(() => regrantedNative.isClosed()).toBe(true)
  })
})
