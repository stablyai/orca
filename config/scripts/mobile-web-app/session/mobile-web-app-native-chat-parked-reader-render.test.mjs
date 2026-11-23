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

// A reader parked in the phone transcript's opening rows keeps them while new rows arrive below.
const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

const entry = `
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Text, View } from 'react-native'
import { MobileNativeChatPageList } from './src/session/native-chat/transcript/viewport/MobileNativeChatPageList'
import { useMobileNativeChatTailFollow } from './src/session/native-chat/transcript/viewport/use-mobile-native-chat-tail-follow'
import { useMobileNativeChatRowKeys } from './src/session/native-chat/transcript/projection/mobile-native-chat-row-keys'

function Transcript() {
  const [count, setCount] = useState(100)
  const rows = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: 'm' + i,
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Message ' + i }]
      })),
    [count]
  )
  const keys = useMobileNativeChatRowKeys(rows, rows, 'chat')
  const tail = useMobileNativeChatTailFollow({ hasItems: true, scopeKey: 'chat' })
  useEffect(() => {
    window.appendRows = (more) => setCount((was) => was + more)
  }, [])
  return (
    <View style={{ height: 780, width: '100%' }}>
      <MobileNativeChatPageList
        {...tail.pageListProps}
        rows={rows}
        rowKeys={keys}
        layoutKey="default"
        contentContainerStyle={{ padding: 12 }}
        onScroll={() => {}}
        header={null}
        footer={null}
        emptyStateView={null}
        renderItem={({ item }) => (
          <View testID={'chat-row:' + keys.keyOf(item)} style={{ height: 200, padding: 8 }}>
            <Text>{item.id}</Text>
          </View>
        )}
      />
    </View>
  )
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
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'chat-parked-reader-'))
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

/** The rows on screen and their tops; the scroller is the transcript's reverse one. */
function shownRows(page) {
  return page.evaluate(() => {
    const scroller = [...document.querySelectorAll('div')].find(
      (node) => getComputedStyle(node).flexDirection === 'column-reverse'
    )
    const view = scroller.getBoundingClientRect()
    return {
      scrollTop: scroller.scrollTop,
      rows: [...scroller.querySelectorAll('[data-testid^="chat-row:"]')]
        .map((node) => ({ key: node.dataset.testid, box: node.getBoundingClientRect() }))
        .filter(({ box }) => box.bottom > view.top && box.top < view.bottom)
        .map(({ key, box }) => ({ key, top: box.top }))
    }
  })
}

describeRender('native chat transcript in the phone web pages', () => {
  it('keeps a parked reader on their row when more rows arrive than the opening window holds', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 780 } })
    const page = await context.newPage()
    await page.goto(`${origin}/`)
    await page.getByText('m99', { exact: true }).waitFor()
    await page.mouse.move(190, 300)
    await page.mouse.wheel(0, -300)
    // The list keeps a reader's place only once their scroll has rested (300 ms); nothing in the page marks it.
    await page.waitForTimeout(500)
    const parked = await shownRows(page)
    expect(parked.scrollTop).toBeLessThan(-100)
    const [reading] = parked.rows

    await page.evaluate(() => window.appendRows(30))
    await page.getByText('m129', { exact: true }).waitFor()

    await expect
      .poll(async () => (await shownRows(page)).rows.find(({ key }) => key === reading.key)?.top)
      .toBeCloseTo(reading.top, 0)
    await context.close()
  })
})
