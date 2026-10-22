import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
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
  status,
  setPopupFixtureEvidenceName
} from './browser-popup-compatibility-cdp-fixture'
import { waitForHiddenFrameInput } from './hidden-frame-input-readiness-fixture'
import { MIN_POPUP_CONTENT_HEIGHT, MIN_POPUP_CONTENT_WIDTH } from './popup-window-minimum-size'

setPopupFixtureEvidenceName('native-electron-evidence.json')

// A featureless window.open in a modifier-click reaches Electron as a native disposition.
async function installScriptedPopupProbe(page: Page, path: string): Promise<void> {
  await page.evaluate((path) => {
    delete document.body.dataset.message
    document.querySelector('#scripted-native')?.remove()
    const button = document.createElement('button')
    button.id = 'scripted-native'
    button.textContent = 'Scripted popup'
    button.setAttribute(
      'onclick',
      `(window.handles ??= []).push(window.open(${JSON.stringify(path)}))`
    )
    document.body.append(button)
  }, path)
}

async function childPage(url: string): Promise<Page> {
  const find = (): Page | undefined =>
    browser
      ?.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === url)
  await expect.poll(() => Boolean(find())).toBe(true)
  const child = find()
  if (!child) {
    throw new Error(`Missing popup child ${url}`)
  }
  return child
}

async function refreshStatus(): Promise<void> {
  const before = status().revision
  await guest('route').evaluate('console.log("orca-popup-fixture:snapshot")')
  await expect.poll(() => status().revision).toBeGreaterThan(before)
}

describe('hidden Chromium native popup request compatibility', () => {
  it.each(['local', 'route'])(
    'preserves native Shift POST context, title and policy ordering: %s',
    async (name) => {
      const page = guest(name)
      const before = receipts.length
      await page.evaluate(() => {
        const form = document.querySelector('form')
        if (form) {
          form.target = '_self'
          form.action = '/native-post'
        }
      })
      await page.locator('#post').click({ modifiers: ['Shift'] })
      await expect
        .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/native-post'))
        .toMatchObject({
          method: 'POST',
          body: 'code=synthetic%2Bvalue',
          origin,
          fetchSite: 'same-origin',
          fetchMode: 'navigate',
          fetchDest: 'document',
          fetchUser: '?1',
          referrer: `${origin}/${name}`,
          cookie: `synthetic_session=${name}`,
          proxied: name === 'route'
        })
      await page.evaluate('console.log("orca-popup-fixture:snapshot")')
      await expect
        .poll(() =>
          browser
            ?.contexts()
            .flatMap((context) => context.pages())
            .some((candidate) => candidate.url() === `${origin}/native-post`)
        )
        .toBe(true)
      const child = browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url() === `${origin}/native-post`)
      if (!child) {
        throw new Error('Missing native POST child')
      }
      await child.evaluate(() => {
        document.title = 'Another hostile title'
      })
      if (name === 'route') {
        await page.evaluate('console.log("orca-popup-fixture:snapshot")')
      }
      await expect.poll(() => status().native.windows.at(-1)?.title).toBe(origin)
      expect(status().native.windows.at(-1)).toMatchObject({ fullscreen: false, focused: false })
      if (name === 'route') {
        expect(status().native.creation.at(-1)).toMatchObject({
          firstNavigationPolicy: 'disable_non_proxied_udp',
          firstNavigationTitle: 'about:blank',
          firstNavigationOwner: expect.any(Number)
        })
      }
      expect(status().native.requests.at(-1)).toEqual({
        disposition: 'new-window',
        frameName: '',
        features: '',
        post: true
      })
      snapshots.push(status())
      await closeChildren(page)
      for (const id of ['multipart', 'empty']) {
        const beforeBody = receipts.length
        await page.evaluate((id) => {
          const form = document.querySelector(`#${id}`)?.closest('form')
          if (form) {
            form.target = '_self'
            form.action = `/native-${id}`
          }
        }, id)
        await page.locator(`#${id}`).click({ modifiers: ['Shift'] })
        await expect
          .poll(() =>
            receipts.slice(beforeBody).find((receipt) => receipt.path === `/native-${id}`)
          )
          .toMatchObject({
            method: 'POST',
            origin,
            fetchSite: 'same-origin',
            cookie: `synthetic_session=${name}`,
            proxied: name === 'route',
            body: id === 'empty' ? '' : expect.stringContaining('synthetic-multipart'),
            contentType:
              id === 'empty'
                ? 'application/x-www-form-urlencoded'
                : expect.stringMatching(/^multipart\/form-data; boundary=/)
          })
        await expect
          .poll(() =>
            browser
              ?.contexts()
              .flatMap((context) => context.pages())
              .some((candidate) => candidate.url() === `${origin}/native-${id}`)
          )
          .toBe(true)
        await closeChildren(page)
      }
    }
  )

  it.each(['local', 'route'])(
    'withholds cross-site Strict cookies on native and adopted POSTs: %s',
    async (name) => {
      const page = guest(name)
      const targetOrigin = origin.replace('127.0.0.1', 'localhost')
      await page.evaluate((targetOrigin) => {
        const link = document.querySelector('#shift')
        if (link) {
          link.setAttribute('href', `${targetOrigin}/seed`)
        }
      }, targetOrigin)
      await page.locator('#shift').click({ modifiers: ['Shift'] })
      await expect
        .poll(() =>
          browser
            ?.contexts()
            .flatMap((context) => context.pages())
            .some((candidate) => candidate.url() === `${targetOrigin}/seed`)
        )
        .toBe(true)
      for (const child of browser?.contexts().flatMap((context) => context.pages()) ?? []) {
        if (child.url() === `${targetOrigin}/seed`) {
          expect(await child.evaluate('document.cookie')).toContain('strict_cookie=synthetic')
          await child.evaluate('window.close()')
        }
      }
      for (const mode of ['adopted', 'shift', 'no-referrer']) {
        const before = receipts.length
        await page.evaluate(
          ({ targetOrigin, mode }) => {
            const form = document.querySelector('form')
            if (form) {
              form.target = mode === 'adopted' ? '_blank' : '_self'
              form.action = `${targetOrigin}/cross-post`
            }
            if (mode === 'no-referrer') {
              document.querySelector('meta[name=referrer]')?.setAttribute('content', 'no-referrer')
            }
          },
          { targetOrigin, mode }
        )
        await page.locator('#post').click(mode === 'adopted' ? {} : { modifiers: ['Shift'] })
        await expect
          .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/cross-post'))
          .toMatchObject({
            method: 'POST',
            body: 'code=synthetic%2Bvalue',
            origin: mode === 'no-referrer' ? 'null' : origin,
            fetchSite: 'cross-site',
            fetchMode: 'navigate',
            fetchDest: 'document',
            cookie: '',
            referrer: mode === 'no-referrer' ? '' : `${origin}/`,
            proxied: name === 'route'
          })
        await expect
          .poll(() =>
            browser
              ?.contexts()
              .flatMap((context) => context.pages())
              .some((candidate) => candidate.url() === `${targetOrigin}/cross-post`)
          )
          .toBe(true)
        await closeChildren(page)
        await page.evaluate(() =>
          document
            .querySelector('meta[name=referrer]')
            ?.setAttribute('content', 'strict-origin-when-cross-origin')
        )
      }
      expect(status().windowsHidden).toBe(true)
      snapshots.push(status())
    }
  )

  it.each(['local', 'route'])(
    'keeps named, sized and openerless script children adopted: %s',
    async (name) => {
      const page = guest(name)
      for (const [frameName, features] of [
        ['named-synthetic', ''],
        ['named-synthetic', 'width=420,height=260'],
        ['', 'noopener,noreferrer,width=420,height=260']
      ]) {
        const before = receipts.length
        const nativeCount = status().native.creation.length
        await page.evaluate(
          ({ frameName, features }) => {
            document.querySelector('#feature-probe')?.remove()
            const button = document.createElement('button')
            button.id = 'feature-probe'
            button.onclick = () => {
              window.open('/scripted', frameName, features)
            }
            document.body.append(button)
          },
          { frameName, features }
        )
        await page.locator('#feature-probe').click()
        await expect
          .poll(() => receipts.slice(before).some((receipt) => receipt.path === '/scripted'))
          .toBe(true)
        await expect
          .poll(
            () =>
              browser
                ?.contexts()
                .flatMap((context) => context.pages())
                .some((candidate) => candidate.url() === `${origin}/scripted`),
            { timeout: 5_000 }
          )
          .toBe(true)
        expect(status().native.creation.length).toBe(nativeCount)
        await closeChildren(page)
      }
    }
  )

  it.each(['local', 'route'])(
    'retains subframe and opaque initiator metadata on native Shift POSTs: %s',
    async (name) => {
      const page = guest(name)
      const targetOrigin = origin.replace('127.0.0.1', 'localhost')
      for (const opaque of [false, true]) {
        for (const shift of [false, true]) {
          const before = receipts.length
          await page.evaluate(
            async ({ targetOrigin, opaque, shift }) => {
              document.querySelector('#frame-probe')?.remove()
              const frame = document.createElement('iframe')
              frame.id = 'frame-probe'
              if (opaque) {
                frame.setAttribute(
                  'sandbox',
                  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
                )
              }
              frame.srcdoc = `<form method="post" action="${targetOrigin}/frame-post" target="${shift ? '_self' : '_blank'}"><input name="frame" value="synthetic"><button id="frame-post">POST</button></form>`
              const loaded = new Promise<void>((resolve) => {
                frame.addEventListener('load', () => resolve(), { once: true })
              })
              document.body.append(frame)
              await loaded
              if (!document.querySelector('#frame-gesture')) {
                const button = document.createElement('button')
                button.id = 'frame-gesture'
                button.textContent = 'Synthetic gesture'
                document.body.append(button)
              }
            },
            { targetOrigin, opaque, shift }
          )
          const post = page.frameLocator('#frame-probe').locator('#frame-post')
          if (opaque) {
            await waitForHiddenFrameInput(post)
            // Opaque frame input does not reach the route's root gesture gate.
            await page.locator('#frame-gesture').click()
          }
          await post.click(shift ? { modifiers: ['Shift'] } : {})
          await expect
            .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/frame-post'))
            .toMatchObject({
              method: 'POST',
              body: 'frame=synthetic',
              origin: opaque ? 'null' : origin,
              fetchSite: 'cross-site',
              cookie: '',
              proxied: name === 'route'
            })
          await expect
            .poll(() =>
              browser
                ?.contexts()
                .flatMap((context) => context.pages())
                .some((candidate) => candidate.url() === `${targetOrigin}/frame-post`)
            )
            .toBe(true)
          await closeChildren(page)
        }
      }
      await page.evaluate(() => document.querySelector('#frame-probe')?.remove())
    }
  )

  it.each(['local', 'route'])(
    'keeps the native origin title through hostile cross-site redirects and fullscreen requests: %s',
    async (name) => {
      const page = guest(name)
      const targetOrigin = origin.replace('127.0.0.1', 'localhost')
      await page.evaluate(() => {
        const form = document.querySelector('form')
        if (form) {
          form.target = '_self'
          form.action = '/native-redirect'
        }
      })
      await page.locator('#post').click({ modifiers: ['Shift'] })
      await expect
        .poll(() =>
          browser
            ?.contexts()
            .flatMap((context) => context.pages())
            .some((candidate) => candidate.url() === `${targetOrigin}/native-final`)
        )
        .toBe(true)
      const child = browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url() === `${targetOrigin}/native-final`)
      if (!child) {
        throw new Error('Missing redirected native child')
      }
      await child.evaluate(() => {
        document.title = 'Synthetic trusted login spoof'
        const button = document.createElement('button')
        button.id = 'fullscreen-probe'
        button.onclick = () => {
          void document.documentElement.requestFullscreen().catch(() => {})
        }
        document.body.append(button)
      })
      await child.locator('#fullscreen-probe').click()
      await (name === 'route'
        ? page.evaluate('console.log("orca-popup-fixture:snapshot")')
        : child.evaluate('document.title="Second synthetic spoof"'))
      await expect.poll(() => status().native.windows.at(-1)?.title).toBe(targetOrigin)
      expect(status().native.windows.at(-1)).toMatchObject({ fullscreen: false, focused: false })
      expect(status().windowsHidden).toBe(true)
      snapshots.push(status())
      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true })
        await child.screenshot({ path: join(artifactDir, `${name}-hidden-native-redirect.png`) })
      }
      await closeChildren(page)
    }
  )

  it('blocks the first native request when route authority or WebRTC preparation fails during creation', async () => {
    const page = guest('route')
    for (const failure of ['authority', 'authority-error', 'webrtc', 'close']) {
      await page.evaluate(() => {
        const form = document.querySelector('form')
        if (form) {
          form.target = '_self'
          form.action = '/must-not-execute'
        }
      })
      await page.evaluate((failure) => console.log(`orca-popup-fixture:fail-${failure}`), failure)
      const before = status().native.windows.length
      const receiptCount = receipts.length
      await page.locator('#post').click({ modifiers: ['Shift'] })
      await page.evaluate('console.log("orca-popup-fixture:snapshot")')
      await expect.poll(() => status().native.windows.length).toBe(before + 1)
      await expect.poll(() => status().native.windows.at(-1)?.closed).toBe(true)
      expect(
        receipts.slice(receiptCount).some((receipt) => receipt.path === '/must-not-execute')
      ).toBe(false)
      snapshots.push(status())
      await page.evaluate('console.log("orca-popup-fixture:restore-authority")')
      await page.evaluate(() =>
        document
          .querySelector('meta[name=referrer]')
          ?.setAttribute('content', 'strict-origin-when-cross-origin')
      )
    }
  })

  it('blocks the first adopted link request when route preparation fails during creation', async () => {
    const page = guest('route')
    for (const failure of ['authority', 'webrtc', 'close']) {
      const path = `/adopted-${failure}`
      await page.locator('#link').evaluate((link, path) => link.setAttribute('href', path), path)
      await page.evaluate((failure) => console.log(`orca-popup-fixture:fail-${failure}`), failure)
      const receiptCount = receipts.length
      await page.locator('#link').click()
      await new Promise((resolve) => setTimeout(resolve, 750))
      expect(receipts.slice(receiptCount).some((receipt) => receipt.path === path)).toBe(false)
      await page.evaluate('console.log("orca-popup-fixture:restore-authority")')
    }
    // Control: once preparation passes, the same adopted link does load.
    const receiptCount = receipts.length
    await page.locator('#link').click()
    await expect
      .poll(() => receipts.slice(receiptCount).some((receipt) => receipt.path === '/adopted-close'))
      .toBe(true)
    await closeChildren(page)
    await page.locator('#link').evaluate((link) => link.setAttribute('href', '/docs'))
  })

  it('prepares modifier-clicked local script window.open children before their first request', async () => {
    const page = guest('local')
    const oauthPath = `/authorize-scripted?client_id=synthetic&redirect_uri=${origin}/callback&response_type=code`
    for (const [modifier, path, disposition] of [
      ['Shift', '/scripted-native', 'new-window'],
      // A Cmd/Ctrl-opened OAuth child keeps its opener instead of becoming an Orca tab.
      ['ControlOrMeta', oauthPath, 'background-tab']
    ] as const) {
      const before = receipts.length
      const hosted = status().childRequests.length
      const tabs = status().tabOpens.length
      await installScriptedPopupProbe(page, path)
      await page.locator('#scripted-native').click({ modifiers: [modifier] })
      await expect
        .poll(() => receipts.slice(before).find((receipt) => path.startsWith(receipt.path)))
        .toMatchObject({ method: 'GET', cookie: 'synthetic_session=local', proxied: false })
      await expect
        .poll(() => page.locator('body').getAttribute('data-message'))
        .toBe('callback:synthetic_session=local')
      await refreshStatus()
      expect(status().native.requests.at(-1)).toEqual({
        disposition,
        frameName: '',
        features: '',
        post: false
      })
      expect(status().childRequests.slice(hosted)).toEqual([
        expect.objectContaining({
          adopted: false,
          native: true,
          sessionMatches: true,
          security: expectedSecurity
        })
      ])
      expect(status().tabOpens.length).toBe(tabs)
      // The page sends a hostile <title>; only a prepared child keeps the origin.
      expect(status().native.windows.at(-1)).toMatchObject({ closed: false, title: origin })
      await closeChildren(page)
    }
    expect(status().windowsHidden).toBe(true)
  })

  it('prepares, caps and fences modifier-clicked route script window.open children', async () => {
    const page = guest('route')
    const children: Page[] = []
    for (const [index, modifier] of (
      ['Shift', 'ControlOrMeta', 'Shift', 'ControlOrMeta'] as const
    ).entries()) {
      const path = `/scripted-route-${index}`
      const before = receipts.length
      await installScriptedPopupProbe(page, path)
      await page.locator('#scripted-native').click({ modifiers: [modifier] })
      await expect
        .poll(() => receipts.slice(before).find((receipt) => receipt.path === path))
        .toMatchObject({ method: 'GET', cookie: 'synthetic_session=route', proxied: true })
      children.push(await childPage(`${origin}${path}`))
      await refreshStatus()
      expect(status().native.requests.at(-1)).toEqual({
        disposition: modifier === 'Shift' ? 'new-window' : 'background-tab',
        frameName: '',
        features: '',
        post: false
      })
      expect(status().native.creation.at(-1)).toMatchObject({
        firstNavigationPolicy: 'disable_non_proxied_udp',
        firstNavigationOwner: expect.any(Number)
      })
    }
    // Four live native children fill the route popup cap.
    await page.locator('#blank').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('false')
    expect(status().native.windows.slice(-4)).toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ closed: false, title: origin }))
    )
    await page.evaluate('console.log("orca-popup-fixture:fence")')
    await expect.poll(() => status().routeGranted).toBe(false)
    for (const child of children) {
      await expect.poll(() => child.isClosed()).toBe(true)
    }
    await page.evaluate('console.log("orca-popup-fixture:grant")')
    await expect.poll(() => status().routeGranted).toBe(true)
    expect(status().windowsHidden).toBe(true)
  })

  it.each(['link', 'script'])(
    'keeps native popups at the origin-safe minimum size: %s',
    async (kind) => {
      const page = guest('local')
      const path = `/native-size-${kind}`
      if (kind === 'link') {
        await page.locator('#shift').evaluate((link, path) => link.setAttribute('href', path), path)
        await page.locator('#shift').click({ modifiers: ['Shift'] })
      } else {
        await installScriptedPopupProbe(page, path)
        await page.locator('#scripted-native').click({ modifiers: ['Shift'] })
      }
      const child = await childPage(`${origin}${path}`)
      // Control: the hidden native child does honor page resizes above the floor.
      await child.evaluate('window.resizeTo(640, 480)')
      await expect
        .poll(async () => {
          await refreshStatus()
          return status().native.windows.at(-1)?.contentSize[0]
        })
        .toBe(640)
      await child.evaluate('window.resizeTo(100, 100)')
      await expect
        .poll(async () => {
          await refreshStatus()
          return status().native.windows.at(-1)?.contentSize
        })
        .toEqual([MIN_POPUP_CONTENT_WIDTH, MIN_POPUP_CONTENT_HEIGHT])
      await closeChildren(page)
      await page.locator('#shift').evaluate((link) => link.setAttribute('href', '/shift'))
    }
  )
})
