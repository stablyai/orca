import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import * as esbuild from 'esbuild'
import {
  MOBILE_WEB_APP_ROOT_RESET,
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  mobileWebAppBuildOptions
} from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeProtocolVersion,
  readBridgeFaultGrant,
  readShellCsp
} from '../preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))
const visualPath = '/_orca_visual/00000000-0000-4000-8000-000000000001.html'
const report = `<style>body{padding:20px;font:16px system-ui}button{padding:12px;margin-right:8px}h1{font-size:24px}[hidden]{display:none!important}</style>
<h1>Company report</h1><button onclick="show('finance')">Finance</button><button onclick="show('retail')">Retail</button>
<section id="finance"><h2>Profit contribution</h2><p>Company profit increased.</p></section>
<section id="retail" hidden><h2>Retail metrics</h2><p>Retail revenue increased.</p></section>
<script>window.switches=0;function show(name){window.switches++;document.getElementById('finance').hidden=name!=='finance';document.getElementById('retail').hidden=name!=='retail'}</script>`
const entry = `
import { createRoot } from 'react-dom/client'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { RpcClientProvider } from './src/transport/connection/client-context'
import { createShellPageClient, bootstrapShellPage } from './src/mobile-web-shell/bridge/page-bootstrap'
import { MobileNativeChatVisual } from './src/session/native-chat/visual/MobileNativeChatVisual'
const client=createShellPageClient()
bootstrapShellPage({target:document.documentElement,client,replaceUrl:()=>{},refuseUnroutedShell:()=>{},mount(client){
 createRoot(document.getElementById('root')).render(<RpcClientProvider client={client}><SafeAreaProvider initialMetrics={{frame:{x:0,y:0,width:390,height:844},insets:{top:0,right:0,bottom:0,left:0}}}>
  <MobileNativeChatVisual directive={{file:'report.html',title:'Interactive report'}} source={{client,sessionId:'codex-report'}} />
 </SafeAreaProvider></RpcClientProvider>)
}})
`

const describeRender = mobileWebAppDependenciesPresent() ? describe : describe.skip
let scratch, server, origin, visualDocument, version, faultGrant
const browsers = {}
let buildNativeChatVisualDocument

beforeAll(async () => {
  if (!mobileWebAppDependenciesPresent()) {
    return
  }
  ;({ buildNativeChatVisualDocument } =
    await import('../../../../src/shared/native-chat/native-chat-visual-shell'))
  version = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  const policySource = await readFile(
    join(
      mobileDir,
      'modules/orca-mobile-web-shell/android/src/main/java/expo/modules/orcamobilewebshell/MobileWebShellVisualDocuments.kt'
    ),
    'utf8'
  )
  const policy = policySource.split('MOBILE_WEB_SHELL_VISUAL_CSP =')[1].split('/**')[0]
  const visualCsp = [...policy.matchAll(/"([^"]+)"/g)].map((match) => match[1]).join('')
  if (!visualCsp.includes('sandbox allow-scripts')) {
    throw new Error('Missing shipped visual policy')
  }
  visualDocument = buildNativeChatVisualDocument({
    html: report,
    channel: 'report-channel',
    theme: { colorScheme: 'light', tokens: {} },
    base: 'document'
  })
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'interactive-visual-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: {
      contents: entry,
      resolveDir: mobileDir,
      loader: 'tsx',
      sourcefile: 'interactive-report.tsx'
    },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'report',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${MOBILE_WEB_APP_ROOT_RESET}${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}</head><body><div id="root"></div><script type="module" src="/report.js"></script></body></html>`
  )
  const served = await createBundleServer({
    outDir,
    cspHeader: await readShellCsp(),
    handleRequest(request, response) {
      if (request.url === visualPath) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': visualCsp,
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store'
        })
        response.end(visualDocument)
        return true
      }
      return false
    }
  })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browsers.chromium = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
  browsers.webkit = await webkit.launch({ headless: true })
}, 180000)
afterAll(async () => {
  await browsers.chromium?.close()
  await browsers.webkit?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function open(browser, interactive = true) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const shell = {
    version,
    sessionId: 'report-shell',
    buildId: 'report-build',
    route: { pathname: '/h/report/session/workspace' },
    host: { id: 'report', name: 'Report host', endpoint: 'ws://report', lastConnected: 1 },
    storage: {},
    faultGrant,
    grants: [faultGrant, ...(interactive ? ['native.visual.document'] : [])],
    replies: { 'agentSession.readVisual': { ok: true, revision: 'a'.repeat(64), html: report } }
  }
  await page.addInitScript({
    content: `if(window===window.top)(${installShellDouble.toString()})(${JSON.stringify(shell)});`
  })
  await page.addInitScript(
    ({ url, version }) => {
      if (window !== window.top) {
        return
      }
      const channel = globalThis.orcaBridge
      const original = channel.postMessage
      globalThis.__visualCalls = []
      channel.postMessage = (json) => {
        const frame = JSON.parse(json)
        if (frame.type === 'request' && frame.method === 'native.visual.document') {
          globalThis.__visualCalls.push(frame.params)
          const result =
            frame.params.action === 'open'
              ? { kind: 'ready', url, channel: 'report-channel' }
              : { kind: 'released' }
          queueMicrotask(() =>
            channel.onmessage?.({
              data: JSON.stringify({
                v: version,
                type: 'reply',
                id: frame.id,
                payload: { id: frame.id, ok: true, result }
              })
            })
          )
        } else {
          original(json)
        }
      }
    },
    { url: origin + visualPath, version }
  )
  await page.goto(origin, { waitUntil: 'load' })
  await page.locator('iframe').first().waitFor()
  return { page, context, errors }
}

for (const engine of ['chromium', 'webkit']) {
  describeRender(`interactive mobile chat reports on ${engine}`, () => {
    it('switches an authored button inline and full screen, retaining opaque isolation', async () => {
      const { page, context, errors } = await open(browsers[engine])
      const inline = page.frameLocator('iframe').first()
      await expect.poll(() => inline.getByText('Profit contribution').isVisible()).toBe(true)
      await inline.getByRole('button', { name: 'Retail', exact: true }).tap()
      await expect.poll(() => inline.getByText('Retail metrics').isVisible()).toBe(true)
      expect(await inline.getByText('Profit contribution').isVisible()).toBe(false)
      if (process.env.ORCA_VISUAL_PROOF_DIR) {
        await page.screenshot({
          path: join(process.env.ORCA_VISUAL_PROOF_DIR, `${engine}-after.png`)
        })
      }
      await page
        .getByRole('button', { name: 'Open Interactive report full screen', exact: true })
        .tap()
      const expanded = page.frameLocator('iframe').last()
      await page
        .locator('iframe')
        .last()
        .evaluate(async (iframe) => {
          const animations = []
          for (let node = iframe; node; node = node.parentElement) {
            animations.push(...node.getAnimations())
          }
          await Promise.all(
            animations
              .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
              .map((animation) => animation.finished.catch(() => {}))
          )
        })
      await expanded.getByRole('button', { name: 'Retail', exact: true }).tap()
      if (process.env.ORCA_VISUAL_PROOF_DIR) {
        await page.screenshot({
          path: join(process.env.ORCA_VISUAL_PROOF_DIR, `${engine}-expanded.png`)
        })
      }
      await expect.poll(() => expanded.getByText('Retail metrics').isVisible()).toBe(true)
      await page.getByRole('button', { name: 'Close', exact: true }).tap()
      await expect.poll(() => page.locator('iframe').count()).toBe(1)
      expect(await inline.getByText('Retail metrics').isVisible()).toBe(true)
      await expect
        .poll(() =>
          page.evaluate(() => globalThis.__visualCalls.filter((c) => c.action === 'release').length)
        )
        .toBe(1)
      expect(errors).toEqual([])
      await context.close()
    })

    it('denies parent DOM, bridge, storage, nested frames and network while the report script runs', async () => {
      const { page, context } = await open(browsers[engine])
      await expect.poll(() => page.frames().some((f) => f.url().endsWith(visualPath))).toBe(true)
      const frame = page.frames().find((f) => f.url().endsWith(visualPath))
      const proof = await frame.evaluate(async () => {
        const denied = (fn) => {
          try {
            fn()
            return false
          } catch {
            return true
          }
        }
        return {
          parent: denied(() => parent.document.body.innerHTML),
          storage: denied(() => localStorage.setItem('probe', 'value')),
          bridge: window.orcaBridge === undefined,
          network: await fetch('/manifest.json', { mode: 'no-cors' }).then(
            () => false,
            () => true
          )
        }
      })
      expect(proof).toEqual({ parent: true, storage: true, bridge: true, network: true })
      const nested = await frame.evaluate(
        () =>
          new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 1000)
            document.addEventListener('securitypolicyviolation', (event) => {
              if (event.effectiveDirective === 'frame-src') {
                clearTimeout(timeout)
                resolve(true)
              }
            })
            const child = document.createElement('iframe')
            child.src = location.href
            document.body.append(child)
          })
      )
      expect(nested).toBe(true)
      expect(await page.evaluate(() => typeof window.show)).toBe('undefined')
      await page.evaluate(() => {
        const inline = document.createElement('script')
        inline.textContent = 'window.inlineEscape=true'
        document.head.append(inline)
      })
      expect(await page.evaluate(() => window.inlineEscape)).toBeUndefined()
      await context.close()
    })

    it('keeps an older shell script-free instead of sending an unsupported native call', async () => {
      const { page, context } = await open(browsers[engine], false)
      const preview = page.frameLocator('iframe').first()
      await preview.getByRole('button', { name: 'Retail', exact: true }).tap()
      expect(await preview.getByText('Profit contribution').isVisible()).toBe(true)
      if (process.env.ORCA_VISUAL_PROOF_DIR) {
        await page.screenshot({
          path: join(process.env.ORCA_VISUAL_PROOF_DIR, `${engine}-before.png`)
        })
      }
      expect(await page.evaluate(() => globalThis.__visualCalls)).toEqual([])
      await context.close()
    })
  })
}
