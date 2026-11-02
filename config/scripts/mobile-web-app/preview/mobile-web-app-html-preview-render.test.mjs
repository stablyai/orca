// Test opaque HTML preview in Chromium/WebKit under shipped CSP; no-header controls prove each forbidden behavior could occur.
// Use srcdoc: WebKit refuses blob frames inheriting frame-ancestors none even when frame-src blob is allowed.
// Pixel oracle works across engines; WebKit refuses evaluation inside opaque-origin frame.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import { lucideBarrelPlugin } from '../../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  readShellCsp,
  readShellDocumentHeaders
} from './mobile-web-app-render-harness.mjs'
import { createCspReportSink } from './mobile-web-app-preview-csp-reports.mjs'
import { startArtifactAssetServer } from './mobile-web-app-preview-asset-server.mjs'
import { openPreviewArm } from './mobile-web-app-preview-arm-driver.mjs'
import {
  ARTIFACT_RGB,
  ENTRY_SOURCE,
  artifactScript
} from './mobile-web-app-preview-artifact-fixture.mjs'
import { waitForRecordedNavigation } from './mobile-web-app-preview-frame-readiness.mjs'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

/** Where the preview sits once mounted, which is what the pixel oracle samples. */
const FRAME_PROBE = { x: 60, y: 200, width: 4, height: 4 }

/** The page behind the frame, so a frame that painted nothing reads as this instead. */
const PAGE_RGB = '17,17,17'

/** Where the artifact's links and subresources point, and the origin that counts what it asked for. */
let foreignOrigin = null
const foreignHits = []
let foreign = null

// Use real TLS listener started before page: Chrome isolates srcdoc target and parser’s first image can race interception attachment.
// https://127.0.0.1 exercises img-src https scheme without needing resolvable remote hostname.
let assetServer = null

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch = null
let outDir = null
let shippedCsp = null

const browsers = {}
// Separate servers for sealed/control arms: header is read once per server, so switching shared header would race.
let sealedServer = null
let openServer = null
// Permissive Referrer-Policy control proves observer can see header: Chromium omits srcdoc image referrer under either policy.
let leakyServer = null
const origins = {}
let shippedDocumentHeaders = null
/** Every refusal the sealed server's policy was told about, by the arm that caused it. */
const cspReports = createCspReportSink()

beforeAll(async () => {
  shippedCsp = await readShellCsp()
  shippedDocumentHeaders = await readShellDocumentHeaders()
  if (!bundles) {
    return
  }
  foreignHits.length = 0
  foreign = createServer((request, response) => {
    foreignHits.push(request.url)
    if (request.url.endsWith('.png')) {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
          'base64'
        )
      )
      return
    }
    response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' })
    response.end('<html><body>FOREIGN</body></html>')
  })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  foreignOrigin = `http://127.0.0.1:${String(foreign.address().port)}`
  // Onto the rig as well: the driver reads it from there, and the binding above is assigned after
  // this module's top level has already built the object.
  rig.foreignOrigin = foreignOrigin

  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'html-preview-render-'))
  // Before any page exists, which is the point of it being a listener.
  assetServer = await startArtifactAssetServer(scratch)
  rig.assetServer = assetServer
  outDir = join(scratch, 'bundle')
  await mkdir(outDir, { recursive: true })
  await esbuild.build({
    absWorkingDir: mobileDir,
    stdin: {
      contents: ENTRY_SOURCE,
      resolveDir: join(mobileDir, 'src/components'),
      loader: 'tsx',
      sourcefile: 'html-preview-check.tsx'
    },
    bundle: true,
    format: 'iife',
    outfile: join(outDir, 'html-preview-check.js'),
    target: ['es2022'],
    jsx: 'automatic',
    logLevel: 'silent',
    // Reuse shipped Lucide shim; barrel reexports missing LucideProvider and toolbar otherwise fails linking.
    plugins: [lucideBarrelPlugin],
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    // Prefer web siblings, including .web.jsx/.web.js; native WebView/Fabric SVG paths fail in browser.
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js'],
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' }
  })
  await writeFile(
    join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head>' +
      `<body style="margin:0;background:rgb(${PAGE_RGB})">` +
      // Give flex:1 outer View definite viewport-height flex ancestor or frame paints at zero height.
      '<div id="root" style="display:flex;flex-direction:column;height:100vh"></div>' +
      '<script src="/html-preview-check.js"></script></body></html>'
  )
  const sealed = await createBundleServer({
    outDir,
    // Per document, because each arm's policy names an endpoint carrying that arm's nonce.
    cspHeader: (request) => cspReports.policyFor(shippedCsp, request),
    documentHeaders: shippedDocumentHeaders,
    handleRequest: (request, response, path) => cspReports.handleRequest(request, response, path)
  })
  sealedServer = sealed.server
  origins.shipped = sealed.origin
  const bare = await createBundleServer({ outDir, cspHeader: null })
  openServer = bare.server
  origins.none = bare.origin
  const leaky = await createBundleServer({
    outDir,
    cspHeader: shippedCsp,
    documentHeaders: { 'Referrer-Policy': 'unsafe-url' }
  })
  leakyServer = leaky.server
  origins.leaky = leaky.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browsers.chromium = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
  // WebKit has no system-browser override; missing download skips rather than relabeling Chromium.
  browsers.webkit = await webkit.launch({ headless: true }).catch(() => null)
}, 300_000)

afterAll(async () => {
  await browsers.chromium?.close()
  await browsers.webkit?.close()
  sealedServer?.close()
  openServer?.close()
  leakyServer?.close()
  foreign?.close()
  assetServer?.server.close()
  if (scratch) {
    // Remove this run’s scratch only; other suites share mobile/.tmp.
    await rm(scratch, { recursive: true, force: true })
  }
})

/** The rig's own state, handed to the driver: one object rather than a module of loose bindings. */
const rig = {
  origins,
  foreignHits,
  cspReports,
  clip: FRAME_PROBE,
  nonce: 0,
  foreignOrigin: null,
  assetServer: null
}

/** Mounts the preview with one artifact and reports everything a case can assert on. */
const open = async (browser, options) => await openPreviewArm(rig, browser, options)

for (const engine of ['chromium', 'webkit']) {
  describeRender(
    `the HTML preview's sealed frame on ${engine}`,
    () => {
      const browser = () => {
        const one = browsers[engine]
        if (!one) {
          throw new Error(`${engine} is not installed for playwright-core`)
        }
        return one
      }

      it('paints the artifact under the policy the shell already ships', async (ctx) => {
        const read = await open(browser(), { signal: ctx.signal })
        expect(read.frameCount).toBe(1)
        // Read srcdoc/no-src attributes, not engine-dependent frame URL, to prove artifact is embedded rather than fetched.
        expect(read.mountedSrcDoc).toContain('ARTIFACT_RENDERED')
        expect(read.mountedSrc).toBeNull()
        expect(read.mountedSandbox).toBe(read.declaredSandbox)
        expect(read.mountedSandbox).toBe('allow-top-navigation-by-user-activation')
        // Append report-uri only to shipped CSP; endpoint changes reporting, not enforcement.
        const servedParts = (read.servedCsp ?? '').split('; report-uri ')
        expect(servedParts[0]).toBe(shippedCsp)
        expect(servedParts).toHaveLength(2)
        expect(read.pixel).toBe(ARTIFACT_RGB)
        // Embedder violation event does not cross frames: empty list proves parent clean only. Pixel and counting server measure inherited style/image/font policy.
        expect(read.violations).toEqual([])
      }, 120_000)

      it('does not run the artifact, behind two fences either of which would hold', async (ctx) => {
        const sealed = await open(browser(), {
          extra: { body: artifactScript(foreignOrigin) },
          signal: ctx.signal,
          // Await known refusal before interpreting absent companion report; list must not be read too early.
          reportReady: 'img-src'
        })
        expect(sealed.pixel).toBe(ARTIFACT_RGB)
        expect(sealed.inside?.ran).toBe(0)
        expect(sealed.inside?.title).toBe('ARTIFACT')
        expect(sealed.inside?.marker).toBe('ARTIFACT_RENDERED')

        // No-policy/allow-scripts control must run same artifact or inert script assertion could pass empty fixture.
        const loose = await open(browser(), {
          signal: ctx.signal,
          extra: { body: artifactScript(foreignOrigin) },
          csp: null,
          sandbox: 'allow-scripts allow-top-navigation-by-user-activation',
          // Wait script’s own marker write; marker element exists before execution.
          frameReady: 'script'
        })
        expect(loose.pixel).toBe(ARTIFACT_RGB)
        expect(loose.inside?.ran).toBe(1)
        expect(loose.inside?.title).toBe('SCRIPT_RAN')
        expect(loose.reported).toEqual([])

        // With allow-scripts but shipped CSP, inline srcdoc script remains blocked; verify policy independently of sandbox.
        const inherited = await open(browser(), {
          signal: ctx.signal,
          extra: { body: artifactScript(foreignOrigin) },
          sandbox: 'allow-scripts allow-top-navigation-by-user-activation',
          // Await browser refusal report rather than racing frame-local list.
          reportReady: 'script-src'
        })
        expect(inherited.pixel).toBe(ARTIFACT_RGB)
        expect(inherited.inside?.ran).toBe(0)
        expect(inherited.inside?.title).toBe('ARTIFACT')
        // Require script-src report: unwidened sandbox also blocks script silently and would falsely prove CSP fence. Browser report avoids flaky frame listener.
        expect(inherited.reported.join(' ')).toContain('script-src')
        // Sealed arm reports only image refusal: sandbox prevents script from starting, before policy can reject it.
        expect(sealed.reported.join(' ')).toContain('img-src')
        expect(sealed.reported.join(' ')).not.toContain('script-src')
      }, 180_000)

      it('refuses the artifact cleartext subresources by scheme and its font by directive', async (ctx) => {
        const sealed = await open(browser(), { signal: ctx.signal })
        expect(sealed.pixel).toBe(ARTIFACT_RGB)
        expect(sealed.foreignHits).toEqual([])
        // Cleartext image refusal proves scheme gate; https control must remain because img-src now admits remote TLS images. font-src none denies either scheme.
        const control = await open(browser(), { csp: null, signal: ctx.signal })
        expect(control.pixel).toBe(ARTIFACT_RGB)
        expect(control.foreignHits).toEqual(
          expect.arrayContaining(['/img.png', '/css-bg.png', '/probe.woff2'])
        )
      }, 120_000)

      it('loads the artifact https images the directive admits, and still refuses its font', async (ctx) => {
        // Await both images explicitly; bounded settle once observed background before element on loaded Chrome.
        const read = await open(browser(), {
          assets: assetServer.origin,
          frameReady: 'images',
          signal: ctx.signal
        })
        expect(read.pixel).toBe(ARTIFACT_RGB)
        // img-src governs CSS background and img element; require both requests.
        expect([...read.secureHits].sort()).toEqual(['/css-bg.png', '/img.png'])
        // Same HTTPS origin still cannot load font; img-src admission must not widen font-src.
        expect(read.secureHits).not.toContain('/probe.woff2')
      }, 120_000)

      it('sends no referrer with an admitted https image, which is the shell header doing it', async (ctx) => {
        const sealed = await open(browser(), {
          assets: assetServer.origin,
          frameReady: 'images',
          signal: ctx.signal
        })
        // Require admitted image requests before interpreting empty referrers.
        expect(sealed.secureHits.length).toBe(2)
        expect(sealed.secureReferers).toEqual([null, null])

        // WebKit leaks embedder/session URL with permissive header despite iframe no-referrer; require shell Referrer-Policy. Chromium omits either way.
        const leaky = await open(browser(), {
          assets: assetServer.origin,
          csp: 'leaky',
          frameReady: 'images',
          signal: ctx.signal
        })
        expect(leaky.secureHits.length).toBe(2)
        const leaked = leaky.secureReferers.filter((one) => one !== null)
        if (engine === 'webkit') {
          expect(leaked.length).toBe(2)
          expect(leaked.every((one) => one.startsWith(origins.leaky))).toBe(true)
        } else {
          expect(leaked).toEqual([])
        }
      }, 180_000)

      it('asks to navigate the top frame to the shell itself, which the shell must refuse', async (ctx) => {
        // Artifact / resolves to shell document and would reset bridge/page state; count actual navigation passed to native refusal delegate.
        const root = await open(browser(), {
          signal: ctx.signal,
          expectNavigation: 'main-frame',
          act: async ({ frame }) => {
            await frame?.click('#rootlink', { timeout: 2000 })
          }
        })
        expect(root.pixelBefore).toBe(ARTIFACT_RGB)
        // Require tap landed before comparing navigation counters; missed click cannot prove refusal.
        expect(root.actError).toBeNull()
        expect(root.ownOriginTopNavigations).toBe(1)
        expect(root.topNavigations).toBe(0)
      }, 180_000)

      // Without externalNavigation grant, older shells silently drop link taps; remove anchor/underline/focus affordance instead.
      // Compare painted granted/hidden arms and their own published click/style state. Granted-link navigation has separate case/budget: third shared arm once timed out after missed CI click.
      it('renders an artifact link as text against a shell that cannot open one', async (ctx) => {
        const hidden = await open(browser(), {
          signal: ctx.signal,
          grants: ['navigate', 'storage'],
          act: async ({ frame }) => {
            // Hidden tap expects no navigation, so use bounded settle rather than waiting for nonexistent record.
            await frame?.click('#toplink', { timeout: 2000 })
          }
        })
        // Require artifact painted before asserting hidden affordance; failed load cannot count as inert links.
        expect(hidden.grants).not.toContain('externalNavigation')
        expect(hidden.pixelBefore).toBe(ARTIFACT_RGB)
        expect(hidden.frameCount).toBe(1)
        expect(hidden.inside?.marker).toBe('ARTIFACT_RENDERED')
        expect(hidden.toggles?.map((one) => one.selected)).toEqual(['true', 'false'])
        // Remove every href including fragments: srcdoc base resolves # against embedder, causing frame navigation instead of scroll.
        expect(hidden.links?.linked).toBe(0)
        expect(hidden.links?.anchors).toBe(5)
        expect(hidden.links?.text).toBe('tap')
        expect(hidden.links?.decoration).toBe('none')
        expect(hidden.links?.focusable).toBe(false)
        // Assert click landed first; three zero counters cannot distinguish missed click from inert target.
        expect(hidden.actError).toBeNull()
        expect(hidden.topNavigations).toBe(0)
        expect(hidden.ownOriginTopNavigations).toBe(0)
        expect(hidden.popups).toBe(0)
        // Sandbox also forbids top navigation if inert-link pass misses anchor.
        expect(hidden.mountedSandbox).toBe('')

        // Read granted arm before tapping; top-frame navigation blanks iframe and resets computed styles, invalidating affordance measurement.
        const shown = await open(browser(), { signal: ctx.signal })
        expect(shown.grants).toContain('externalNavigation')
        expect(shown.pixel).toBe(ARTIFACT_RGB)
        expect(shown.links?.linked).toBe(5)
        expect(shown.links?.anchors).toBe(5)
        expect(shown.links?.text).toBe('tap')
        expect(shown.links?.decoration).toBe('underline')
        expect(shown.links?.focusable).toBe(true)
        // WebKit computes auto cursor for linked/unlinked anchors, resolving pointer only at hit-test. Assert cursor discrimination in Chromium; other affordances cover WebKit.
        if (engine === 'chromium') {
          expect(shown.links?.cursor).toBe('pointer')
          expect(hidden.links?.cursor).not.toBe('pointer')
        } else {
          expect(shown.links?.cursor).toBe(hidden.links?.cursor)
        }
        expect(shown.mountedSandbox).toBe('allow-top-navigation-by-user-activation')
      }, 240_000)

      // Parser round-trip must preserve artifact rendering beyond links; real browser catches doctype/newline losses happy-dom misses. Granted arm is unchanged control.
      it('changes nothing an engine renders except that links are not links', async (ctx) => {
        // A doctype with a public identifier and no system identifier, which is quirks. The bare
        // name is not, so a pass that rewrote one as the other moves the whole artifact between
        // layout modes -- which is what this arm exists to catch.
        const quirks = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">'
        const shown = await open(browser(), { signal: ctx.signal, doctype: quirks })
        const hidden = await open(browser(), {
          signal: ctx.signal,
          doctype: quirks,
          grants: ['navigate', 'storage']
        })
        // Both painted, so every comparison below is between two rendered documents.
        expect(shown.pixel).toBe(ARTIFACT_RGB)
        expect(hidden.pixel).toBe(ARTIFACT_RGB)
        expect(shown.grants).toContain('externalNavigation')
        expect(hidden.grants).not.toContain('externalNavigation')

        // srcdoc inherits embedder CSS1Compat regardless of own doctype; compatMode cannot prove preservation, but pin inheritance behavior.
        expect(shown.inside?.compatMode).toBe('CSS1Compat')
        expect(hidden.inside?.compatMode).toBe(shown.inside?.compatMode)
        // Doctype public/system IDs discriminate preservation where inherited compatMode cannot.
        expect(shown.inside?.doctypePublicId).toBe('-//W3C//DTD HTML 4.01 Transitional//EN')
        expect(hidden.inside?.doctypePublicId).toBe(shown.inside?.doctypePublicId)
        expect(hidden.inside?.doctypeSystemId).toBe(shown.inside?.doctypeSystemId)
        // Bare-doctype control proves ID reader can distinguish lost identifier.
        const bare = await open(browser(), { signal: ctx.signal, grants: ['navigate', 'storage'] })
        expect(bare.inside?.doctypePublicId).toBe('')

        // Browser parser drops leading pre newline; inert-link serializer must restore it.
        expect(shown.inside?.preText).toBe('\nkept')
        expect(hidden.inside?.preText).toBe(shown.inside?.preText)

        // Granted fragment remains known broken navigation; hidden arm must strip it rather than preserve false scroll affordance.
        expect(shown.inside?.fragmentHref).toBe('#fragtarget')
        expect(hidden.inside?.fragmentHref).toBeNull()
        expect(hidden.links?.linked).toBe(0)
        expect(shown.links?.linked).toBe(5)
      }, 240_000)

      // srcdoc #fragment resolves against embedder base, triggering frame-src none instead of scrolling; Chromium can replace artifact with error page.
      // Granted control retains known bug (followup-html-preview-fragment-links.md) and proves navigation counters see it; hidden arm must remain inert.
      it('taps a fragment link, which navigates this frame rather than scrolling it', async (ctx) => {
        // Require overflow content so no-scroll assertion has meaningful alternative.
        const tall = { body: '<div style="height:1600px">spacer</div>' }
        const tapFragment = async ({ frame }) => {
          await frame?.click('#fraglink', { timeout: 2000 })
        }

        const shown = await open(browser(), {
          signal: ctx.signal,
          extra: tall,
          act: tapFragment,
          reportAfterAct: 'frame-src'
        })
        expect(shown.actError).toBeNull()
        // Require embedder base URL, which makes fragment target off-document.
        expect(shown.inside?.baseUri ?? shown.mountedSrcDoc).toBeTruthy()
        // Granted control must observe forbidden frame navigation absent in hidden arm.
        expect(shown.reported).toContain('frame-src')

        const hidden = await open(browser(), {
          signal: ctx.signal,
          extra: tall,
          grants: ['navigate', 'storage'],
          act: tapFragment
        })
        expect(hidden.actError).toBeNull()
        expect(hidden.reported).not.toContain('frame-src')
        expect(hidden.inside?.marker).toBe('ARTIFACT_RENDERED')
        expect(hidden.inside?.fragmentHref).toBeNull()
        expect(hidden.inside?.scrollY).toBe(0)
        expect(hidden.topNavigations).toBe(0)
        expect(hidden.popups).toBe(0)
      }, 240_000)

      it("hands a user's tap on a link to the top frame, exactly once", async (ctx) => {
        const read = await open(browser(), {
          signal: ctx.signal,
          expectNavigation: 'main-frame',
          act: async ({ frame }) => {
            await frame?.click('#toplink', { timeout: 2000 })
          }
        })
        expect(read.pixelBefore).toBe(ARTIFACT_RGB)
        expect(read.topNavigations).toBe(1)
        expect(read.ownOriginTopNavigations).toBe(0)
        expect(read.popups).toBe(0)
      }, 120_000)

      it("cannot reach the shell through a meta refresh at the embedder's own URL", async (ctx) => {
        // Same-origin meta-refresh targets shell document; foreign-origin arm cannot prove shell-origin counter works.
        const own = await open(browser(), {
          signal: ctx.signal,
          extra: { head: '<meta http-equiv="refresh" content="0;url=/">' }
        })
        // Require painted artifact before interpreting navigation refusal.
        expect(own.pixelBefore).toBe(ARTIFACT_RGB)
        // Link-to-/ control reads one on same counter, proving refresh zero is observable.
        expect(own.ownOriginTopNavigations).toBe(0)
        expect(own.topNavigations).toBe(0)
        // Also reject self-frame shell-document fetch, which would embed session page inside preview.
        expect(own.ownOriginFrameNavigations).toBe(0)

        // No-policy/allow-same-origin control must navigate frame to shell / to prove observer is not blind.
        const loose = await open(browser(), {
          signal: ctx.signal,
          csp: null,
          sandbox: 'allow-scripts allow-same-origin allow-top-navigation',
          extra: { head: '<meta http-equiv="refresh" content="0;url=/">' },
          // Navigating arm no longer contains marker; await navigation instead of artifact readiness.
          frameReady: 'load',
          expectNavigation: 'frame'
        })
        expect(loose.ownOriginFrameNavigations).toBe(1)

        // Test sandbox token alone with no CSP; navigation must never begin or report.
        const tokenOnly = await open(browser(), {
          signal: ctx.signal,
          csp: null,
          extra: { head: '<meta http-equiv="refresh" content="0;url=/">' }
        })
        expect(tokenOnly.pixelBefore).toBe(ARTIFACT_RGB)
        expect(tokenOnly.ownOriginFrameNavigations).toBe(0)
        expect(tokenOnly.ownOriginTopNavigations).toBe(0)
        expect(tokenOnly.violations).toEqual([])

        // Test CSP alone with allow-same-origin: frame-src none blocks request at embedder; engines leave different content, so assert no server request.
        const policyOnly = await open(browser(), {
          signal: ctx.signal,
          sandbox: 'allow-scripts allow-same-origin allow-top-navigation',
          extra: { head: '<meta http-equiv="refresh" content="0;url=/">' },
          frameReady: 'load'
        })
        expect(policyOnly.ownOriginFrameNavigations).toBe(0)
        expect(policyOnly.ownOriginTopNavigations).toBe(0)
        expect(policyOnly.violations.join(' ')).toContain('frame-src')
      }, 180_000)

      it('hands up nothing without a tap, and nothing for a form or a new window', async (ctx) => {
        const meta = await open(browser(), {
          signal: ctx.signal,
          extra: { head: `<meta http-equiv="refresh" content="0;url=${foreignOrigin}/meta.html">` }
        })
        expect(meta.topNavigations).toBe(0)
        expect(meta.ownOriginTopNavigations).toBe(0)
        const form = await open(browser(), {
          signal: ctx.signal,
          act: async ({ frame }) => {
            await frame.click('#submit', { timeout: 2000 })
          }
        })
        expect(form.actError).toBeNull()
        expect(form.pixelBefore).toBe(ARTIFACT_RGB)
        expect(form.topNavigations).toBe(0)
        const blank = await open(browser(), {
          signal: ctx.signal,
          act: async ({ frame }) => {
            await frame.click('#blanklink', { timeout: 2000 })
          }
        })
        expect(blank.actError).toBeNull()
        expect(blank.pixelBefore).toBe(ARTIFACT_RGB)
        expect(blank.topNavigations).toBe(0)
        expect(blank.popups).toBe(0)
        const allowedForm = await open(browser(), {
          signal: ctx.signal,
          csp: null,
          sandbox: 'allow-forms allow-top-navigation-by-user-activation',
          expectNavigation: 'main-frame',
          act: async ({ frame }) => {
            await frame.click('#submit', { timeout: 2000 })
          }
        })
        expect(allowedForm.pixelBefore).toBe(ARTIFACT_RGB)
        expect(allowedForm.actError).toBeNull()
        expect(allowedForm.topNavigations).toBe(1)
        const allowedBlank = await open(browser(), {
          signal: ctx.signal,
          csp: null,
          sandbox: 'allow-popups allow-popups-to-escape-sandbox',
          act: async ({ page, frame }) => {
            await Promise.all([
              page.waitForEvent('popup', { timeout: 10_000 }),
              frame.click('#blanklink', { timeout: 2000 })
            ])
          }
        })
        expect(allowedBlank.pixelBefore).toBe(ARTIFACT_RGB)
        expect(allowedBlank.actError).toBeNull()
        expect(allowedBlank.popups).toBe(1)
      }, 180_000)

      // Force slow-arm diagnostic sampling branch; formerly unexecuted branch had out-of-scope name and no test/lint coverage.
      it('reads the frame while a navigation it expects has not arrived', async (ctx) => {
        void ctx
        const page = await browser().newPage()
        const printed = []
        const spy = vi.spyOn(console, 'error').mockImplementation((line) => {
          printed.push(String(line))
        })
        const stop = new AbortController()
        const timer = setTimeout(() => stop.abort(), 300)
        await waitForRecordedNavigation(
          page,
          [],
          () => false,
          stop.signal,
          { arm: 'arm sampling-probe', browserVersion: browser().version() },
          { sampleEveryMs: 25 }
        )
        clearTimeout(timer)
        spy.mockRestore()
        await page.close()
        expect(printed).toHaveLength(1)
        expect(printed[0]).toContain('arm sampling-probe')
        expect(printed[0]).toContain('frames [')
      }, 60_000)

      // Force bounded navigation timeout after missed click; require useful diagnostic instead of exhausting whole case budget.
      it('gives up on a navigation that is not coming, and names why', async (ctx) => {
        void ctx
        const page = await browser().newPage()
        try {
          const failed = await waitForRecordedNavigation(
            page,
            [],
            () => false,
            null,
            {
              arm: 'arm bound-probe',
              browserVersion: browser().version(),
              actError: 'locator.click: Timeout 2000ms exceeded'
            },
            { boundMs: 50 }
          ).catch((error) => String(error))
          // Diagnostic needs arm, elapsed wait, click outcome and last frame reading to explain CI timeout.
          expect(failed).toContain('arm bound-probe')
          expect(failed).toMatch(/waited \d+ms for the navigation it expects/)
          expect(failed).toContain('Timeout 2000ms exceeded')
          expect(failed).toContain('frames [')
        } finally {
          await page.close()
        }
      }, 60_000)

      it('keeps the Preview/Source toggle, and Source shows the source', async (ctx) => {
        const read = await open(browser(), {
          signal: ctx.signal,
          act: async ({ page }) => {
            await page.getByLabel('View HTML source').click({ timeout: 2000 })
          }
        })
        // Read toggle labels/state from DOM before and after action, as assistive technology does.
        expect(read.togglesBefore).toEqual([
          { label: 'Preview rendered HTML', selected: 'true' },
          { label: 'View HTML source', selected: 'false' }
        ])
        expect(read.toggles).toEqual([
          { label: 'Preview rendered HTML', selected: 'false' },
          { label: 'View HTML source', selected: 'true' }
        ])
        expect(read.body).toContain('SOURCE_TAB_RENDERED')
        expect(read.frameCount).toBe(0)
        expect(read.pixel).toBe(PAGE_RGB)
      }, 120_000)
    },
    600_000
  )
}
