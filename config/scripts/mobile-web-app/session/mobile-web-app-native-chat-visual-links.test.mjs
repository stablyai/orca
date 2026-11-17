// srcdoc inherits embedder CSP before its meta; test real engines to prove about:srcdoc base keeps #links inside visual.
// WebKit also fires sandboxed-frame load for in-page links; host must not treat that as navigation away.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { readShellCsp } from '../preview/mobile-web-app-render-harness.mjs'

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
    await import('../../../../src/shared/native-chat/visuals/native-chat-visual-shell'))
  ;({ buildMobileNativeChatVisualHostDocument } =
    await import('../../../../mobile/src/session/native-chat/visual/mobile-native-chat-visual-host-document'))
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
