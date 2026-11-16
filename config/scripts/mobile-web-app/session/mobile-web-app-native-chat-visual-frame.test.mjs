// Shipped shell policy and the shell's chat visual frame, in real engines: a visual's own scripts run, and stay off the page.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { readChatVisualFrame, readShellCsp } from '../preview/mobile-web-app-render-harness.mjs'

const bundles = mobileWebAppDependenciesPresent()
const describeEngines = bundles ? describe : describe.skip

const THEME = { colorScheme: 'light', tokens: {} }
const report = (origin) => `
<button id="show-b" onclick="document.getElementById('a').hidden=true;document.getElementById('b').hidden=false">B</button>
<section id="a">Finance</section><section id="b" hidden>Retail</section>
<script>
window.reached = {}
try { if (document.cookie.indexOf('page-secret') !== -1) window.reached.cookie = true } catch (_) {}
try { if (localStorage.getItem('page-secret')) window.reached.storage = true } catch (_) {}
try { window.reached.page = window.top.document.title } catch (_) {}
try { window.reached.frame = window.parent.document.title } catch (_) {}
fetch('${origin}/').then(function () { window.reached.fetch = true }, function () {})
  .then(function () { window.settled = true })
</script>`

const browsers = {}
let server = null
let origin = null
let framePath = null
let documentMessage = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  const { buildNativeChatVisualDocument } =
    await import('../../../../src/shared/native-chat/native-chat-visual-shell')
  const contract =
    await import('../../../../mobile/src/session/native-chat/visual/mobile-native-chat-visual-frame-contract')
  framePath = contract.MOBILE_NATIVE_CHAT_VISUAL_FRAME_PATH
  const shellCsp = await readShellCsp()
  const frame = await readChatVisualFrame()
  server = createServer((request, response) => {
    if (request.url === framePath) {
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': frame.csp })
      response.end(frame.document)
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': shellCsp,
      'set-cookie': 'session=page-secret'
    })
    response.end(
      `<!doctype html><title>page-secret</title><iframe sandbox="allow-scripts" src="${framePath}"></iframe>`
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  documentMessage = contract.mobileNativeChatVisualDocumentMessage(
    buildNativeChatVisualDocument({ html: report(origin), channel: 'c1', theme: THEME }),
    'Report'
  )
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
  server?.close()
})

async function openReport(browser) {
  const page = await browser.newPage()
  await page.goto(`${origin}/`)
  await expect.poll(() => page.frames().length).toBe(2)
  // The page posts from its own script; evaluate stands in for it under the same policy.
  await page.evaluate((message) => {
    localStorage.setItem('page-secret', '1')
    document.querySelector('iframe').contentWindow.postMessage(message, '*')
  }, documentMessage)
  await expect.poll(() => page.frames().length).toBe(3)
  const report = page.frames().find((one) => one.url() === 'about:srcdoc')
  await expect
    .poll(() => report.evaluate(() => typeof window.reached).catch(() => null))
    .toBe('object')
  return { page, report }
}

for (const engine of ['chromium', 'webkit']) {
  describeEngines(
    `a chat visual in the shell's frame on ${engine}`,
    () => {
      const browser = () => {
        const one = browsers[engine]
        if (!one) {
          throw new Error(`${engine} is not installed for playwright-core`)
        }
        return one
      }

      it("runs the report's own controls", async () => {
        const { page, report } = await openReport(browser())
        await report.click('#show-b')
        expect(await report.evaluate(() => document.getElementById('b').hidden)).toBe(false)
        expect(await report.evaluate(() => document.getElementById('a').hidden)).toBe(true)
        await page.close()
      })

      it("cannot reach the page's document, cookies, storage or origin", async () => {
        const { page, report } = await openReport(browser())
        await expect.poll(() => report.evaluate(() => window.settled === true)).toBe(true)
        expect(await report.evaluate(() => window.reached)).toEqual({})
        await page.close()
      })
    },
    120_000
  )
}
