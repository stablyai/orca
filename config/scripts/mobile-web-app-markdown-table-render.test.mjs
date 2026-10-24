import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { PNG } from 'pngjs'
import { chromium, webkit } from 'playwright-core'
import { mobileWebAppBuildOptions } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from './mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))
const ENTRY = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ScrollView } from 'react-native'
import { MobileNativeChatMessage } from './src/session/MobileNativeChatMessage'
import { RpcClientProvider } from './src/transport/client-context.web'
import { colors } from './src/theme/mobile-theme'
const short = '| Name | State |\\n|---|---|\\n| Android | Ready |\\n| iOS | Review |'
const wide = '| Component | Description | Owner | Validation |\\n|---|---|---|---|\\n| Android | Longer content stays inside the table viewport | Mobile team | Browser checks |'
const client = { getShellSession: () => ({ grants: { native: [] } }) }
createRoot(document.getElementById('root')).render(
  <RpcClientProvider client={client}>
    <ScrollView style={{ height: '100vh', backgroundColor: colors.bgBase }}>
      {[short, wide].map((text, index) =>
        <div id={'table-' + index} key={index}>
          <MobileNativeChatMessage message={{ id: String(index), role: 'assistant', timestamp: null,
            blocks: [{ type: 'text', text }] }} />
        </div>
      )}
    </ScrollView>
  </RpcClientProvider>
)
`

let scratch
let server
let origin
const available = mobileWebAppDependenciesPresent()

beforeAll(async () => {
  if (!available) {
    return
  }
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'table-border-'))
  const { entryPoints: _entryPoints, ...options } = mobileWebAppBuildOptions([])
  await esbuild.build({
    ...options,
    stdin: { contents: ENTRY, resolveDir: mobileDir, loader: 'tsx' },
    outdir: scratch,
    entryNames: 'table-check',
    publicPath: '/',
    write: true
  })
  await writeFile(
    join(scratch, 'index.html'),
    '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{margin:0}#root{height:100vh}</style><div id="root"></div>' +
      '<script type="module" src="/table-check.js"></script></html>'
  )
  const served = await createBundleServer({ outDir: scratch, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
}, 600_000)

afterAll(async () => {
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

function luminance(channels) {
  const linear = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast(first, second) {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// Sample the painted arc, including antialiasing, rather than only its declared CSS color.
function cornerContrast(png, box, radius, horizontal, vertical, fill) {
  const scale = png.width / 390
  const centerX = (horizontal === 1 ? box.x + radius : box.x + box.width - radius) * scale
  const centerY = (vertical === 1 ? box.y + radius : box.y + box.height - radius) * scale
  return [15, 30, 45, 60, 75].map((angle) => {
    const radians = (angle * Math.PI) / 180
    const x = Math.round(centerX - horizontal * (radius - 0.5) * scale * Math.cos(radians))
    const y = Math.round(centerY - vertical * (radius - 0.5) * scale * Math.sin(radians))
    let best = 1
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const offset = ((y + dy) * png.width + x + dx) * 4
        best = Math.max(best, contrast([...png.data.subarray(offset, offset + 3)], fill))
      }
    }
    return best
  })
}

const describeTables = available ? describe : describe.skip
describeTables('phone chat table borders', () => {
  for (const { name, engine } of [
    { name: 'chromium', engine: chromium },
    { name: 'webkit', engine: webkit }
  ]) {
    it(`${name}: keeps all four rounded edges visible before and after horizontal scrolling`, async () => {
      const executablePath = name === 'chromium' ? process.env.ORCA_MOBILE_WEB_RENDER_BROWSER : null
      const browser = await engine.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {})
      })
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          hasTouch: true
        })
        await page.goto(origin)
        await page.getByText('Android', { exact: true }).first().waitFor()
        for (const index of [0, 1]) {
          const table = page.locator(`#table-${index}`)
          await table.evaluate((host) => {
            const frame = [...host.querySelectorAll('div')].find(
              (node) => getComputedStyle(node).borderTopWidth === '1px'
            )
            frame.setAttribute('data-table-frame', '')
          })
          const frame = table.locator('[data-table-frame]')
          await frame.scrollIntoViewIfNeeded()
          const metrics = await frame.evaluate((node) => {
            const scroll = node.firstElementChild
            return { viewport: scroll.clientWidth, content: scroll.scrollWidth }
          })
          expect(metrics.content > metrics.viewport + 1).toBe(index === 1)
          for (const end of index === 1 ? [false, true] : [false]) {
            await frame.evaluate((node, end) => {
              node.firstElementChild.scrollLeft = end ? node.firstElementChild.scrollWidth : 0
            }, end)
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve))
                )
            )
            const offset = await frame.evaluate((node) => node.firstElementChild.scrollLeft)
            expect(offset > 0).toBe(end)
            const box = await frame.boundingBox()
            const { radius, header, body } = await frame.evaluate((node) => {
              const rows = node.firstElementChild.firstElementChild.firstElementChild.children
              const rgb = (value) =>
                value
                  .match(/[\d.]+/g)
                  .slice(0, 3)
                  .map(Number)
              return {
                radius: Number.parseFloat(getComputedStyle(node).borderRadius),
                header: rgb(getComputedStyle(rows[0].firstElementChild).backgroundColor),
                body: rgb(getComputedStyle(node).backgroundColor)
              }
            })
            const png = PNG.sync.read(await page.screenshot())
            for (const horizontal of [1, -1]) {
              for (const vertical of [1, -1]) {
                for (const ratio of cornerContrast(
                  png,
                  box,
                  radius,
                  horizontal,
                  vertical,
                  vertical === 1 ? header : body
                )) {
                  expect(
                    ratio,
                    `${name} table ${index} corner ${horizontal}/${vertical}`
                  ).toBeGreaterThanOrEqual(1.5)
                }
              }
            }
          }
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
      } finally {
        await browser.close()
      }
    })
  }
})
