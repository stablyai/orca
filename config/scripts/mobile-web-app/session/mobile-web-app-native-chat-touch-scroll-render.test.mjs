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

// The phone's web pages scroll the transcript by touch only while its pinch detector leaves the browser's panning on.
const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

const entry = `
import { createRoot } from 'react-dom/client'
import { Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileNativeChatPageScroll } from './src/session/native-chat/transcript/MobileNativeChatPageScroll'
import {
  MobileNativeChatPinchZoom,
  useMobileNativeChatPinchGesture
} from './src/session/native-chat/transcript/mobile-native-chat-pinch-zoom'

function Transcript() {
  const { pinchGesture } = useMobileNativeChatPinchGesture('chat')
  return <View style={{ height: 600 }}>
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
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}</head>` +
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

describeRender('native chat transcript in the phone web pages', () => {
  it('leaves touch panning to the browser under the pinch detector', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    await page.goto(`${origin}/`)
    const transcript = page.getByTestId('transcript')
    await transcript.waitFor()
    expect(
      await transcript.evaluate((element) => [
        element.scrollHeight > element.clientHeight,
        getComputedStyle(element).touchAction
      ])
    ).toEqual([true, 'auto'])
    await page.close()
  })
})
