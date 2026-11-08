import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  artifactDir,
  browser,
  closeChildren,
  expectedSecurity,
  guest,
  origin,
  receipts,
  snapshots,
  status
} from './browser-popup-compatibility-cdp-fixture'

describe('hidden Chromium popup compatibility', () => {
  it.each(['local', 'route'])(
    'preserves bare OAuth and blank handles, messages, sessions and close: %s',
    async (name) => {
      const page = guest(name)
      await page.locator('#oauth').click()
      await expect.poll(() => page.locator('body').getAttribute('data-handle')).toBe('true')
      await expect
        .poll(() => page.locator('body').getAttribute('data-message'))
        .toBe(`callback:synthetic_session=${name}`)
      expect(await page.evaluate('!!window.popup.opener')).toBe(true)
      await expect
        .poll(() =>
          browser
            ?.contexts()
            .flatMap((context) => context.pages())
            .some((candidate) => candidate.url().startsWith('data:text/html;charset=utf-8,'))
        )
        .toBe(true)
      const bar = browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('data:text/html;charset=utf-8,'))
      if (!bar) {
        throw new Error('Missing adopted origin bar')
      }
      await expect.poll(() => bar.locator('#origin').innerText()).toBe(origin)
      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true })
        await bar.screenshot({ path: join(artifactDir, `${name}-hidden-origin-bar.png`) })
      }
      await closeChildren(page)
      await expect.poll(() => page.evaluate('window.popup.closed')).toBe(true)
      await page.locator('#blank').click()
      await expect
        .poll(() => page.locator('body').getAttribute('data-message'))
        .toBe(`blank:synthetic_session=${name}`)
      expect(await page.evaluate('window.popup.location.href')).toBe('about:blank#state')
      expect(await page.evaluate('window.popup.eval("Notification.requestPermission()")')).toBe(
        'denied'
      )
      if (name === 'route') {
        expect(
          await page.evaluate('window.popup.eval(\'window.open("about:blank")===null\')')
        ).toBe(true)
        await page.evaluate('console.log("orca-popup-fixture:snapshot")')
        await expect.poll(() => status().routeContents.length).toBe(2)
        expect(status().routeContents).toEqual([
          { security: expectedSecurity, webRtcPolicy: 'disable_non_proxied_udp' },
          { security: expectedSecurity, webRtcPolicy: 'disable_non_proxied_udp' }
        ])
      }
      snapshots.push(status())
      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true })
        await page.screenshot({ path: join(artifactDir, `${name}-hidden-guest.png`) })
        const child = browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url() === 'about:blank#state')
        await child?.screenshot({ path: join(artifactDir, `${name}-hidden-blank.png`) })
      }
      await page.evaluate(`window.popup.location.href=${JSON.stringify(`${origin}/callback`)}`)
      await expect
        .poll(() => page.locator('body').getAttribute('data-message'))
        .toBe(`callback:synthetic_session=${name}`)
      await closeChildren(page)
      expect(status().windowsHidden).toBe(true)
      if (name === 'local') {
        expect(status().childRequests.every((request) => request.adopted)).toBe(true)
      }
    }
  )

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

  it('keeps ordinary local link activation and modifier-click tab UX', async () => {
    const page = guest('local')
    await page.locator('#link').click()
    await expect
      .poll(() => status().tabOpens.at(-1))
      .toEqual({ url: `${origin}/docs`, activate: true })
    await page.locator('#background').click({ button: 'middle' })
    await expect
      .poll(() => status().tabOpens.at(-1))
      .toEqual({ url: `${origin}/background`, activate: false })
    const before = receipts.length
    await page.locator('#shift').click({ modifiers: ['Shift'] })
    await expect
      .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/shift'))
      .toMatchObject({
        method: 'GET',
        referrer: `${origin}/local`,
        cookie: 'synthetic_session=local'
      })
    expect(status().childRequests.at(-1)).toMatchObject({
      adopted: false,
      native: true,
      sessionMatches: true,
      security: expectedSecurity
    })
    await expect.poll(() => status().childRequests.at(-1)?.permission).toBe('denied')
    expect(status().childRequests.every((request) => request.sessionMatches)).toBe(true)
    snapshots.push(status())
    await closeChildren(page)
  })

  it('opens opener-less OAuth links as tabs and preserves original modifier POSTs', async () => {
    const page = guest('local')
    const before = receipts.length
    const hostedBefore = status().childRequests.length
    const oauthUrl = `${origin}/authorize-link?client_id=synthetic&redirect_uri=${origin}/callback&response_type=code`
    for (const [modifiers, activate] of [
      [[], true],
      [['ControlOrMeta', 'Shift'], true],
      [['ControlOrMeta'], false]
    ] as const) {
      const tabCount = status().tabOpens.length
      await page.locator('#oauth-link').click({ modifiers: [...modifiers] })
      await expect.poll(() => status().tabOpens.length).toBe(tabCount + 1)
      expect(status().tabOpens.at(-1)).toEqual({ url: oauthUrl, activate })
    }
    expect(status().childRequests.length).toBe(hostedBefore)
    expect(receipts.slice(before).some(({ path }) => path === '/authorize-link')).toBe(false)
    const beforePost = receipts.length
    await page.locator('#post').click({ modifiers: ['ControlOrMeta', 'Shift'] })
    await expect
      .poll(() => receipts.slice(beforePost).find(({ path }) => path === '/post'))
      .toMatchObject({
        method: 'POST',
        body: 'code=synthetic%2Bvalue',
        cookie: 'synthetic_session=local',
        referrer: `${origin}/local`,
        origin,
        proxied: false
      })
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(receipts.slice(beforePost).filter(({ path }) => path === '/post')).toHaveLength(1)
    await closeChildren(page)
    expect(status().windowsHidden).toBe(true)
  })

  it('preserves remote modifier GETs and original POSTs without replay', async () => {
    const page = guest('route')
    const before = receipts.length
    await page.locator('#link').click({ modifiers: ['ControlOrMeta', 'Shift'] })
    await expect
      .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/docs'))
      .toMatchObject({ method: 'GET', cookie: 'synthetic_session=route', proxied: true })
    await expect
      .poll(() =>
        browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .some((candidate) => candidate.url() === `${origin}/docs`)
      )
      .toBe(true)
    await page.evaluate('console.log("orca-popup-fixture:snapshot")')
    expect(
      status().routeContents.every(({ webRtcPolicy }) => webRtcPolicy === 'disable_non_proxied_udp')
    ).toBe(true)
    await closeChildren(page)
    const beforePost = receipts.length
    await page.locator('#post').click({ modifiers: ['ControlOrMeta', 'Shift'] })
    await expect
      .poll(() => receipts.slice(beforePost).find(({ path }) => path === '/post'))
      .toMatchObject({
        method: 'POST',
        body: 'code=synthetic%2Bvalue',
        cookie: 'synthetic_session=route',
        referrer: `${origin}/route`,
        origin,
        proxied: true
      })
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(receipts.slice(beforePost).filter(({ path }) => path === '/post')).toHaveLength(1)
    await page.evaluate('console.log("orca-popup-fixture:snapshot")')
    expect(
      status().routeContents.every(({ webRtcPolicy }) => webRtcPolicy === 'disable_non_proxied_udp')
    ).toBe(true)
    expect(status().windowsHidden).toBe(true)
  })

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
