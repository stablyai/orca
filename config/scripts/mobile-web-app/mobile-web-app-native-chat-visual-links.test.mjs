// srcdoc inherits embedder CSP before its meta; test real engines to prove about:srcdoc base keeps #links inside visual.
// WebKit also fires sandboxed-frame load for in-page links; host must not treat that as navigation away.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { readShellCsp } from './preview/mobile-web-app-render-harness.mjs'

const bundles = mobileWebAppDependenciesPresent()
const describeEngines = bundles ? describe : describe.skip

const THEME = { colorScheme: 'light', tokens: {} }
const PONG_TIMEOUT_MS = 300
const VISUAL =
  '<style>section{height:900px}section:target{outline:1px solid}</style>' +
  '<script>window.marker = String(Math.random())</script>' +
  '<a id="to-s2" href="#s2">s2</a> <a id="to-route" href="#/reports">reports</a>' +
  '<section id="s1">one</section><section id="s2">two</section>'
const BRIDGE =
  '<script>window.sent=[];window.ReactNativeWebView={postMessage:function(m){window.sent.push(JSON.parse(m))}}</script>'

const browsers = {}
let shellServer = null
let shellOrigin = null
let pongType = null
let buildNativeChatVisualDocument = null
let buildMobileNativeChatVisualHostDocument = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  // Import behind dependency gate: transforming mobile/ reads Expo tsconfig absent from root-only shards.
  ;({ buildNativeChatVisualDocument, NATIVE_CHAT_VISUAL_PONG_TYPE: pongType } =
    await import('../../../src/shared/native-chat-visual-shell'))
  ;({ buildMobileNativeChatVisualHostDocument } =
    await import('../../../mobile/src/session/mobile-native-chat-visual-host-document'))
  const header = await readShellCsp()
  const sealed = buildNativeChatVisualDocument({ html: VISUAL, channel: 'sealed', theme: THEME })
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

async function openNativeHost(browser, html = VISUAL) {
  const page = await browser.newPage()
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'))
  const visualDocument = buildNativeChatVisualDocument({ html, channel: 'c1', theme: THEME })
  const host = buildMobileNativeChatVisualHostDocument({
    visualDocument,
    channel: 'c1',
    token: 'token',
    title: 'Visual',
    mode: 'fullscreen',
    pongTimeoutMs: PONG_TIMEOUT_MS
  })
  const recorder = `<script>
window.visualLoads = 0;
window.visualPongs = [];
document.addEventListener('load', function(event) {
  if (event.target.tagName === 'IFRAME') window.visualLoads += 1;
}, true);
window.addEventListener('message', function(event) {
  var frame = document.querySelector('iframe');
  if (frame && event.source === frame.contentWindow && event.data && event.data.type === ${JSON.stringify(pongType)}) {
    window.visualPongs.push(event.data.id);
  }
});
</script>`
  await page.setContent(host.replace('<head>\n', `<head>\n${BRIDGE}\n${recorder}\n`))
  const frame = await visualFrame(page)
  await expect
    .poll(() => frame.evaluate(() => typeof window.marker).catch(() => null))
    .toBe('string')
  return { page, frame }
}

const escaped = (page) =>
  page.evaluate(() => window.sent.some((message) => message.kind === 'escaped'))

async function outlastTheAnswer(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          channel.port1.close()
          channel.port2.close()
          resolve()
        }
        channel.port2.postMessage(null)
      })
  )
  await expect
    .poll(() =>
      page.evaluate(() => window.visualLoads < 2 || window.visualPongs.includes(window.visualLoads))
    )
    .toBe(true)
  await page.clock.runFor(PONG_TIMEOUT_MS * 3)
}

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

      it.each(['let', 'const', 'var', 'function'])(
        'renders a visual declaring %s open',
        async (kind) => {
          const declaration =
            kind === 'function' ? 'function open() { return 6 }' : `${kind} open = 6`
          const html = `${VISUAL}<p id="rendered"></p><script>${declaration};
document.getElementById('rendered').textContent = String(typeof open === 'function' ? open() : open)
</script>`
          const { page, frame } = await openNativeHost(browser(), html)
          try {
            await expect.poll(() => frame.textContent('#rendered')).toBe('6')
          } finally {
            await page.close()
          }
        }
      )

      it('blocks popups even when a visual restores the native open function', async () => {
        const context = await browser().newContext()
        try {
          await context.addInitScript(() => {
            window.originalOpen = window.open
          })
          const html = `${VISUAL}<button id="popup" onclick="this.dataset.blocked = String(window.open('about:blank', '_blank') === null)">Open</button>`
          const { frame } = await openNativeHost(context, html)
          expect(
            await frame.evaluate(() => {
              window.open = window.originalOpen
              return window.open === window.originalOpen
            })
          ).toBe(true)
          await frame.click('#popup')
          expect(await frame.getAttribute('#popup', 'data-blocked')).toBe('true')
          expect(context.pages()).toHaveLength(1)
        } finally {
          await context.close()
        }
      })

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
          await expect.poll(() => page.evaluate(() => window.visualLoads)).toBeGreaterThan(1)
          await page.clock.runFor(PONG_TIMEOUT_MS + 1)
          await expect.poll(() => escaped(page)).toBe(true)
          expect(await page.evaluate(() => document.querySelector('iframe'))).toBeNull()
          await page.close()
        }
      })

      it('keeps a visual that reran its own page, which is the same host-owned document', async () => {
        const { page, frame } = await openNativeHost(browser())
        const marker = await frame.evaluate(() => window.marker)
        await frame.evaluate(() => location.reload()).catch(() => {})
        await expect.poll(() => frame.evaluate(() => window.marker)).not.toBe(marker)
        await expect.poll(() => page.evaluate(() => window.visualLoads)).toBeGreaterThan(1)
        await outlastTheAnswer(page)
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
