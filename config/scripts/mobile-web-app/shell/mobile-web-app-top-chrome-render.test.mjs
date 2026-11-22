import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import * as esbuild from 'esbuild'
import {
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from '../preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))
const engines = [
  {
    name: 'chromium',
    launch: () => {
      const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
      return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
    }
  },
  { name: 'webkit', launch: () => webkit.launch({ headless: true }) }
]

const entry = `
import { createRoot } from 'react-dom/client'
import { View } from 'react-native'
import { SafeAreaFrameContext, SafeAreaInsetsContext, SafeAreaView } from 'react-native-safe-area-context'
import { RpcClientProvider } from './src/transport/connection/client-context.web'
import { useTopChromeSpace } from './src/layout/use-top-chrome-space'

const session = { pageGeometry: {
    occlusions: [{ x: 535, y: 0, width: 134, height: 82 }], sideRail: false
  } }
const client = {
  getShellSession: () => session,
  onPageGeometryUpdate: () => () => {}
}
function Header() {
  const { ref, onLayout, space } = useTopChromeSpace()
  return <View ref={ref} onLayout={onLayout}>
    <SafeAreaView edges={space ? [] : ['top']} style={space && {
      paddingLeft: space.left, paddingRight: space.right, minHeight: space.minHeight
    }}>
      <View testID="header-row" style={{ height: 52 }} />
    </SafeAreaView>
  </View>
}
createRoot(document.getElementById('root')).render(
  <RpcClientProvider client={client}>
    <SafeAreaFrameContext.Provider value={{ x: 0, y: 0, width: innerWidth, height: innerHeight }}>
      <SafeAreaInsetsContext.Provider value={{ top: 82, right: 0, bottom: 34, left: 0 }}>
        <View testID="entry-screen" style={{ width: 669, transform: [{ translateX: 669 }] }}>
          <Header />
        </View>
      </SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  </RpcClientProvider>
)
`

const bundles = mobileWebAppDependenciesPresent()
const describeChrome = bundles ? describe : describe.skip
const browsers = new Map()
let scratch
let server
let origin

beforeAll(async () => {
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-top-chrome-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: { contents: entry, resolveDir: mobileDir, loader: 'tsx', sourcefile: 'top-chrome.tsx' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'top-chrome',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}<div id="root"></div>` +
      '<script type="module" src="/top-chrome.js"></script>'
  )
  const served = await createBundleServer({ outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
  for (const engine of engines) {
    browsers.set(engine.name, await engine.launch())
  }
}, 180_000)

afterAll(async () => {
  for (const browser of browsers.values()) {
    await browser.close()
  }
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

describeChrome.each(engines)('top chrome in $name', (engine) => {
  it('shares the Duo status strip using layout coordinates through a screen translation', async () => {
    const page = await browsers.get(engine.name).newPage({ viewport: { width: 669, height: 951 } })
    try {
      await page.goto(origin, { waitUntil: 'load' })
      const row = page.getByTestId('header-row')
      await expect.poll(async () => (await row.boundingBox())?.y).toBe(0)
      await page.getByTestId('entry-screen').evaluate((screen) => {
        screen.style.transform = 'none'
      })
      await expect
        .poll(async () => {
          const box = await row.boundingBox()
          return box && { x: box.x, y: box.y, width: box.width }
        })
        .toEqual({ x: 0, y: 0, width: 535 })
    } finally {
      await page.close()
    }
  })
})
