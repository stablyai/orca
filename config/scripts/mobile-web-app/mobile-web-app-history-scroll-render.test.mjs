import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import {
  mobileWebAppBuildOptions,
  MOBILE_WEB_APP_ROOT_RESET,
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE
} from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from './preview/mobile-web-app-render-harness.mjs'
const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))
const entry = `
import { useState, useCallback, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { View, Text, Pressable } from 'react-native'
import { MobileNativeChatPageList } from './src/session/MobileNativeChatPageList'
import { useMobileNativeChatTailFollow } from './src/session/use-mobile-native-chat-tail-follow'
import { useMobileNativeChatRowKeys } from './src/session/native-chat/transcript/mobile-native-chat-row-keys'
function App() {
  const [start, setStart] = useState(80)
  const [older, setOlder] = useState(false)
  const rows = useMemo(
    () =>
      Array.from({ length: 100 - start }, (_, i) => ({
        id: 'm' + (start + i),
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Message ' + (start + i) }]
      })),
    [start]
  )
  const keys = useMobileNativeChatRowKeys(rows, rows, 'history-scroll')
  const tail = useMobileNativeChatTailFollow({ hasItems: true, scopeKey: 'history-scroll' })
  const loadEarlier = useCallback(() => {
    if (start > 0 && !older) {
      setOlder(true)
      setTimeout(() => {
        setStart((s) => Math.max(0, s - 40))
        setOlder(false)
      }, 500)
    }
  }, [start, older])
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Text testID="loaded-start">Loaded from {start}</Text>
        <Pressable accessibilityRole="button" onPress={tail.jumpToTail}>
          <Text>Jump to latest</Text>
        </Pressable>
      </View>
      <MobileNativeChatPageList
        {...tail.pageListProps}
        rows={rows}
        rowKeys={keys}
        layoutKey="default"
        contentContainerStyle={{ padding: 12 }}
        onScroll={() => {}}
        header={<Text>{older ? 'Loading earlier messages' : 'Earlier history'}</Text>}
        footer={<Text>Working</Text>}
        emptyStateView={null}
        onNearTop={loadEarlier}
        renderItem={({ item }) => (
          <View
            testID={'chat-row:' + keys.keyOf(item)}
            style={{
              minHeight:
                Number(item.id.slice(1)) >= 80 ? 40 : 100 + (Number(item.id.slice(1)) % 4) * 40,
              padding: 8
            }}
          >
            <Text>{item.id}: Message history</Text>
            {Number(item.id.slice(1)) >= 97 ? (
              <View style={{ height: 30 }}>
                <Text>Recent image</Text>
              </View>
            ) : null}
          </View>
        )}
      />
    </View>
  )
}
createRoot(document.getElementById('root')).render(<App />)
`
const bundles = mobileWebAppDependenciesPresent()
let scratch, server, origin, browser
beforeAll(async () => {
  if (!bundles) {
    return
  }
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'history-scroll-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: { contents: entry, resolveDir: mobileDir, loader: 'tsx', sourcefile: 'history.tsx' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'history',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${MOBILE_WEB_APP_ROOT_RESET}${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}</head><body><div id="root"></div><script type="module" src="/history.js"></script></body></html>`
  )
  const served = await createBundleServer({ outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
  browser = await chromium.launch({
    headless: true,
    ...(process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
      ? { executablePath: process.env.ORCA_MOBILE_WEB_RENDER_BROWSER }
      : {})
  })
}, 180000)
afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})
const run = bundles ? describe : describe.skip
async function snapshot(page) {
  return page.evaluate(() => {
    const s = [...document.querySelectorAll('div')].find(
      (n) =>
        getComputedStyle(n).flexDirection === 'column-reverse' &&
        ['auto', 'scroll'].includes(getComputedStyle(n).overflowY)
    )
    if (!s) {
      throw new Error('No production scroll root')
    }
    const box = s.getBoundingClientRect()
    const shown = [...s.querySelectorAll('[data-testid^="chat-row:"]')]
      .filter((n) => {
        const r = n.getBoundingClientRect()
        return r.bottom > box.top && r.top < box.bottom
      })
      .map((n) => ({ key: n.getAttribute('data-testid'), top: n.getBoundingClientRect().top }))
    return {
      shown,
      scrollTop: s.scrollTop,
      height: s.scrollHeight,
      drawn: s.querySelectorAll('[data-native-chat-page-row]').length,
      first: s
        .querySelector('[data-native-chat-page-row]')
        ?.getAttribute('data-native-chat-page-row')
    }
  })
}
run('production mobile PageList scrolling', () => {
  it('preserves the reading row through asynchronous older-page loading', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.goto(origin)
      await page.getByText('m99: Message history', { exact: true }).waitFor()
      await page.mouse.move(180, 300)
      await page.mouse.wheel(0, -500)
      await page.waitForTimeout(50)
      const before = await snapshot(page)
      await page.waitForTimeout(500)
      const after = await snapshot(page)
      const anchor = before.shown.find((row) => row.top >= 24) ?? before.shown[0]
      const kept = after.shown.find((row) => row.key === anchor.key)
      expect(kept).toBeDefined()
      expect(Math.abs(kept.top - anchor.top)).toBeLessThanOrEqual(1)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })
  it.each(['touch', 'mouse'])(
    'does not lose position while an older page arrives during a %s gesture',
    async (gestureSourceType) => {
      const page = await browser.newPage({
        viewport: { width: 390, height: 780 },
        hasTouch: true,
        isMobile: true
      })
      try {
        await page.goto(origin)
        await page.getByText('m99: Message history', { exact: true }).waitFor()
        const cdp = await page.context().newCDPSession(page)
        await page.evaluate(() => {
          const root = [...document.querySelectorAll('div')].find(
            (n) =>
              getComputedStyle(n).flexDirection === 'column-reverse' &&
              ['auto', 'scroll'].includes(getComputedStyle(n).overflowY)
          )
          window.historyScrollPositions = [root.scrollTop]
          root.addEventListener('scroll', () => window.historyScrollPositions.push(root.scrollTop))
        })
        const before = await snapshot(page)
        // Touch hit-testing needs a committed compositor frame after the first list layout.
        await page.screenshot()
        // Linux synthetic touch scrolling emits no moves; dispatch native touch events instead.
        if (gestureSourceType === 'touch') {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: 190, y: 180 }]
          })
          for (let step = 1; step <= 50; step++) {
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [{ x: 190, y: 180 + step * 10 }]
            })
            await page.waitForTimeout(1000 / 30)
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        } else {
          await cdp.send('Input.synthesizeScrollGesture', {
            x: 190,
            y: 180,
            yDistance: 500,
            speed: 300,
            gestureSourceType,
            preventFling: true
          })
        }
        await page.waitForTimeout(600)
        const after = await snapshot(page)
        const positions = await page.evaluate(() => window.historyScrollPositions)
        expect(
          Math.max(...positions.slice(1).map((value, i) => Math.abs(value - positions[i])))
        ).toBeLessThan(100)
        expect(after.scrollTop).toBeLessThan(-100)
        expect(after.scrollTop).toBeGreaterThan(-600)
        expect(after.first).toBe('m0')
        expect(after.height).toBeGreaterThan(before.height + 6000)
        const extent = after.height
        await page.mouse.move(180, 300)
        await page.mouse.wheel(0, 100)
        await page.waitForTimeout(400)
        expect((await snapshot(page)).height).toBe(extent)
        await page.getByRole('button', { name: 'Jump to latest' }).click()
        await page.waitForTimeout(400)
        expect((await snapshot(page)).scrollTop).toBe(0)
      } finally {
        await page.close()
      }
    }
  )
})
