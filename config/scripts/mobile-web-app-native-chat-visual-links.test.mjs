/**
 * A chat visual's in-page links on both mobile surfaces, in real engines.
 *
 * The visual is a srcdoc document, and a srcdoc document inherits its embedder's policy before its
 * own meta parses. So whether the shell's `about:srcdoc` base applies -- and with it whether `#x`
 * stays in the visual -- is decided by the host page's policy, which only an engine can answer.
 * WebKit as well as Chromium, because WebKit also fires the frame's `load` for an in-page link in a
 * sandboxed frame, which the host must not mistake for the visual navigating away.
 */
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { readShellCsp } from './mobile-web-app-render-harness.mjs'

const bundles = mobileWebAppDependenciesPresent()
const describeEngines = bundles ? describe : describe.skip

const THEME = { colorScheme: 'light', tokens: {} }
// Short so a real escape is reported quickly; the shipped wait is the same mechanism, longer.
const PONG_TIMEOUT_MS = 300
const VISUAL =
  '<style>section{height:900px}section:target{outline:1px solid}</style>' +
  '<script>window.marker = String(Math.random())</script>' +
  '<a id="to-s2" href="#s2">s2</a> <a id="to-route" href="#/reports">reports</a>' +
  '<section id="s1">one</section><section id="s2">two</section>'
// Stands in for the WebView bridge: the host page posts here, and the test reads what it sent.
const BRIDGE =
  '<script>window.sent=[];window.ReactNativeWebView={postMessage:function(m){window.sent.push(JSON.parse(m))}}</script>'

const browsers = {}
let shellServer = null
let shellOrigin = null
let buildNativeChatVisualDocument = null
let buildMobileNativeChatVisualHostDocument = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  // Imported behind the gate: transforming a mobile/ module reads mobile/tsconfig.json, which
  // extends a package the root-only unit shards do not install (see the session-dictation check).
  ;({ buildNativeChatVisualDocument } = await import('../../src/shared/native-chat-visual-shell'))
  ;({ buildMobileNativeChatVisualHostDocument } =
    await import('../../mobile/src/session/mobile-native-chat-visual-host-document'))
  const header = await readShellCsp()
  const sealed = buildNativeChatVisualDocument({ html: VISUAL, channel: 'sealed', theme: THEME })
  // The web shell's page, under the header the shell ships, holding the visual as the web sibling does.
  shellServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': header })
    response.end(
      `<!doctype html><body><iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${sealed
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')}"></iframe></body>`
    )
  })
  await new Promise((resolve) => shellServer.listen(0, '127.0.0.1', resolve))
  shellOrigin = `http://127.0.0.1:${shellServer.address().port}`
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browsers.chromium = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
  browsers.webkit = await webkit.launch({ headless: true }).catch(() => null)
}, 300_000)

afterAll(async () => {
  await browsers.chromium?.close()
  await browsers.webkit?.close()
  shellServer?.close()
})

async function visualFrame(page) {
  await expect.poll(() => page.frames().length).toBe(2)
  return page.frames().find((one) => one !== page.mainFrame())
}

/** The native host page with one visual, as the WebView loads it (no URL of its own). */
async function openNativeHost(browser, html = VISUAL) {
  const page = await browser.newPage()
  const visualDocument = buildNativeChatVisualDocument({ html, channel: 'c1', theme: THEME })
  const host = buildMobileNativeChatVisualHostDocument({
    visualDocument,
    channel: 'c1',
    token: 'token',
    title: 'Visual',
    mode: 'fullscreen',
    pongTimeoutMs: PONG_TIMEOUT_MS
  })
  await page.setContent(host.replace('<head>\n', `<head>\n${BRIDGE}\n`))
  const frame = await visualFrame(page)
  await expect
    .poll(() => frame.evaluate(() => typeof window.marker).catch(() => null))
    .toBe('string')
  return { page, frame }
}

const escaped = (page) =>
  page.evaluate(() => window.sent.some((message) => message.kind === 'escaped'))

/** Longer than the host waits for an answer, so a missing one would have been reported. */
const outlastTheAnswer = (page) => page.waitForTimeout(PONG_TIMEOUT_MS * 3)

for (const engine of ['chromium', 'webkit']) {
  describeEngines(
    `a chat visual's in-page links on ${engine}`,
    () => {
      const browser = () => {
        const one = browsers[engine]
        if (!one) {
          throw new Error(`${engine} is not installed for playwright-core`)
        }
        return one
      }

      it('moves within the visual in the app, and the host keeps it', async () => {
        const { page, frame } = await openNativeHost(browser())
        const marker = await frame.evaluate(() => window.marker)
        expect(await frame.evaluate(() => document.baseURI)).toBe('about:srcdoc')
        await frame.click('#to-s2')
        await outlastTheAnswer(page)
        expect(await frame.evaluate(() => document.querySelector(':target')?.id)).toBe('s2')
        await frame.click('#to-route')
        await frame.evaluate(() => history.pushState(null, '', '#/pushed'))
        await outlastTheAnswer(page)
        expect(await frame.evaluate(() => location.href)).toBe('about:srcdoc#/pushed')
        expect(await frame.evaluate(() => window.marker)).toBe(marker)
        expect(await escaped(page)).toBe(false)
        await page.close()
      })

      it("refuses a base the visual declares, so the shell's stays", async () => {
        const own = '<head><base href="https://example.com/"></head>'
        const { page, frame } = await openNativeHost(browser(), own + VISUAL)
        expect(await frame.evaluate(() => document.baseURI)).toBe('about:srcdoc')
        await frame.evaluate(() => {
          const base = document.createElement('base')
          base.href = 'https://example.com/'
          document.head.prepend(base)
        })
        expect(await frame.evaluate(() => document.baseURI)).not.toMatch(/^https:/)
        await page.close()
      })

      it('still retires a visual that went blank, from a link or a navigation', async () => {
        for (const leave of [
          () => {
            location.href = 'about:blank'
          },
          () => {
            document.querySelector('base').remove()
            document.getElementById('to-s2').click()
          }
        ]) {
          const { page, frame } = await openNativeHost(browser())
          await frame.evaluate(leave).catch(() => {})
          await expect.poll(() => escaped(page)).toBe(true)
          expect(await page.evaluate(() => document.querySelector('iframe'))).toBeNull()
          await page.close()
        }
      })

      it('keeps a visual that reran its own page, which is the same host-owned document', async () => {
        const { page, frame } = await openNativeHost(browser())
        const marker = await frame.evaluate(() => window.marker)
        await frame.evaluate(() => location.reload()).catch(() => {})
        await outlastTheAnswer(page)
        await expect.poll(() => frame.evaluate(() => window.marker)).not.toBe(marker)
        expect(await escaped(page)).toBe(false)
        await page.close()
      })

      it('moves within the sealed visual on the web shell, under its shipped policy', async () => {
        const page = await browser().newPage()
        await page.goto(`${shellOrigin}/`)
        const frame = await visualFrame(page)
        await frame.click('#to-s2')
        await expect.poll(() => frame.url()).toBe('about:srcdoc#s2')
        await page.close()
      })
    },
    120_000
  )
}
