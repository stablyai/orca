import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from './preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))
const entry = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Pressable, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileNativeChatQueuedMessages } from './src/session/native-chat/input/MobileNativeChatQueuedMessages'
import { mobileQueuedMessageCards } from './src/session/mobile-structured-queued-message-cards'

function Queue() {
  const [count, setCount] = useState(1)
  const messages = Array.from({ length: count }, (_, index) => ({
    messageId: 'message-' + index, position: index + 1, state: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: index === 0
      ? 'First queued message'
      : 'Review the mobile transcript and preserve each reproduction detail. '.repeat(30) }] }
  }))
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <View style={{ flex: 1 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Add message" onPress={() => setCount(n => n + 1)}><Text>Add</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Remove message" onPress={() => setCount(n => Math.max(1, n - 1))}><Text>Remove</Text></Pressable>
      <View style={{ flex: 1 }} />
      <MobileNativeChatQueuedMessages
        cards={mobileQueuedMessageCards(messages, [], { agentWorking: true })}
        onMove={location.hash === '#drag' ? async () => true : undefined}
      />
    </View>
  </GestureHandlerRootView>
}
createRoot(document.getElementById('root')).render(<Queue />)
`
const bundles = mobileWebAppDependenciesPresent()
const describeLayout = bundles ? describe : describe.skip
let scratch, server, origin, browser

beforeAll(async () => {
  if (!bundles) {
    return
  }
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'queued-layout-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: { contents: entry, resolveDir: mobileDir, loader: 'tsx', sourcefile: 'queue.tsx' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'queue',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}</head><body><div id="root"></div><script type="module" src="/queue.js"></script></body></html>`
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

async function geometry(page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="queued-box"]')
    const rows = [...box.querySelectorAll('[data-testid="queued-card-row"]')]
    const scroll = [...box.querySelectorAll('*')].find(
      (node) => getComputedStyle(node).overflowY === 'auto'
    )
    const last = rows.at(-1).getBoundingClientRect()
    const viewport = scroll.getBoundingClientRect()
    return {
      contentHeight: scroll.scrollHeight,
      rowHeight: rows.reduce((sum, node) => sum + node.getBoundingClientRect().height, 0),
      lastBottom: last.bottom,
      viewportBottom: viewport.bottom,
      lastTop: last.top,
      viewportTop: viewport.top
    }
  })
}

describeLayout.each(['plain', 'drag'])('queued text layout (%s)', (mode) => {
  it('keeps hidden full-text measurement out of the scroll range on append and removal', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    try {
      await page.goto(`${origin}/#${mode}`)
      for (let count = 2; count <= 3; count++) {
        await page.getByRole('button', { name: 'Add message', exact: true }).click()
        await expect
          .poll(async () => {
            const g = await geometry(page)
            return g.contentHeight - g.rowHeight
          })
          .toBeLessThanOrEqual(1)
        const g = await geometry(page)
        expect(g.lastBottom).toBeLessThanOrEqual(g.viewportBottom + 1)
        expect(g.lastBottom).toBeGreaterThan(g.viewportTop)
      }
      await page.getByRole('button', { name: 'Remove message', exact: true }).click()
      await page.setViewportSize({ width: 320, height: 480 })
      await expect
        .poll(async () => {
          const g = await geometry(page)
          return g.contentHeight - g.rowHeight
        })
        .toBeLessThanOrEqual(1)
    } finally {
      await page.close()
    }
  }, 30_000)
})
