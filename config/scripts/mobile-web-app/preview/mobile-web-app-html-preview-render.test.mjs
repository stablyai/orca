// Test opaque HTML preview in Chromium/WebKit under shipped CSP; no-header controls prove each forbidden behavior could occur.
// Use srcdoc: WebKit refuses blob frames inheriting frame-ancestors none even when frame-src blob is allowed.
// Pixel oracle works across engines; WebKit refuses evaluation inside opaque-origin frame.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import { mobileWebRenderCheckPlugins } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
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

  scratch = await mkdtemp(join(tmpdir(), 'orca-html-preview-render-'))
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
    plugins: mobileWebRenderCheckPlugins,
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

      // Force slow-arm diagnostic sampling branch; formerly unexecuted branch had out-of-scope name and no test/lint coverage.

      // Force bounded navigation timeout after missed click; require useful diagnostic instead of exhausting whole case budget.
    },
    600_000
  )
}
