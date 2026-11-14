import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import {
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from '../preview/mobile-web-app-render-harness.mjs'

// The phone's web pages must pan the transcript by touch and give a pinch to its text-size detector, not page zoom.
const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

const entry = `
import { createRoot } from 'react-dom/client'
import { Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileNativeChatPageScroll } from './src/session/native-chat/transcript/viewport/MobileNativeChatPageScroll'
import {
  MobileNativeChatPinchZoom,
  useMobileNativeChatPinchGesture
} from './src/session/native-chat/transcript/viewport/mobile-native-chat-pinch-zoom'

function Transcript() {
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture('chat')
  return <View style={{ height: 600, width: '100%' }}>
    <Text testID="font-scale">{fontScale}</Text>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <MobileNativeChatPinchZoom gesture={pinchGesture}>
        <MobileNativeChatPageScroll testID="transcript">
          {Array.from({ length: 60 }, (_, i) => <Text key={i}>message {i}</Text>)}
        </MobileNativeChatPageScroll>
      </MobileNativeChatPinchZoom>
    </GestureHandlerRootView>
  </View>
}
createRoot(document.getElementById('root')).render(<Transcript />)
`

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip
let scratch
let server
let origin
let browser

beforeAll(async () => {
  if (!bundles) {
    return
  }
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'chat-touch-scroll-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: { contents: entry, resolveDir: mobileDir, loader: 'tsx', sourcefile: 'transcript.tsx' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'transcript',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `${MOBILE_WEB_APP_ROOT_RESET}</head>` +
      '<body><div id="root"></div><script type="module" src="/transcript.js"></script></body></html>'
  )
  const served = await createBundleServer({ outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function touch(page, steps) {
  const cdp = await page.context().newCDPSession(page)
  const [first, ...rest] = steps
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: first })
  for (const touchPoints of rest) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints })
    await page.evaluate(() => new Promise(requestAnimationFrame))
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

const frames = (count, at) => Array.from({ length: count + 1 }, (_, step) => at(step / count))

async function openTranscript() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  })
  const page = await context.newPage()
  await page.goto(`${origin}/`)
  await page.getByTestId('transcript').waitFor()
  return page
}

describeRender('native chat transcript in the phone web pages', () => {
  it('pans the transcript under one finger', async () => {
    const page = await openTranscript()
    await touch(
      page,
      frames(10, (t) => [{ x: 195, y: 200 + 300 * t }])
    )
    await expect
      .poll(() => page.getByTestId('transcript').evaluate((element) => element.scrollTop))
      .toBeLessThan(-100)
    await page.context().close()
  })

  it('gives a pinch to the text size, not to page zoom', async () => {
    const page = await openTranscript()
    await touch(
      page,
      frames(10, (t) => [
        { x: 195, y: 330 - 120 * t, id: 0 },
        { x: 195, y: 370 + 120 * t, id: 1 }
      ])
    )
    await expect.poll(() => page.getByTestId('font-scale').textContent()).not.toBe('1')
    expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1)
    await page.context().close()
  })
})
