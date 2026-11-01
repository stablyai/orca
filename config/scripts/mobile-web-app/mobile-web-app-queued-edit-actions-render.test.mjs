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
import { Text, View } from 'react-native'
import { MobileNativeChatComposer } from './src/session/native-chat/composer/MobileNativeChatComposer'
import { activateMobileUiLocale } from './src/i18n/mobile-i18n'
import { queuedMessageStyles } from './src/session/native-chat/input/mobile-native-chat-queued-message-styles'

await activateMobileUiLocale(location.hash.slice(1) || 'en')
function Edit() {
  const [text, setText] = useState('Keep this queued draft')
  const [saved, setSaved] = useState(0)
  const [cancelled, setCancelled] = useState(0)
  return <View style={{ flex: 1, justifyContent: 'flex-end' }}>
    <View testID="queued-edit-container" style={[queuedMessageStyles.list, queuedMessageStyles.inlineList]}>
    <View style={[queuedMessageStyles.box, queuedMessageStyles.inlineBox]}>
    <Text testID="edit-results">{saved + ':' + cancelled}</Text>
    <MobileNativeChatComposer value={text} onChangeText={setText}
      onSend={async () => { setSaved(n => n + 1); return true }}
      agent="codex" sendSurfaceId="queued-edit-render"
      getSendCompletionGeneration={() => 0} getComposerEditGeneration={() => 0}
      editSession={{ cancel: () => setCancelled(n => n + 1), locked: false, refuseCommand: () => false }}
      onAttachImage={() => {}} onMicPress={() => {}}
    />
    </View>
    </View>
  </View>
}
createRoot(document.getElementById('root')).render(<Edit />)
`
const bundles = mobileWebAppDependenciesPresent()
const describeActions = bundles ? describe : describe.skip
let scratch, server, origin, browser

beforeAll(async () => {
  if (!bundles) {
    return
  }
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'queued-edit-actions-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: { contents: entry, resolveDir: mobileDir, loader: 'tsx', sourcefile: 'edit.tsx' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'edit',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}</head><body><div id="root"></div><script type="module" src="/edit.js"></script></body></html>`
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

describeActions.each(['en', 'ru', 'de'])('queued edit actions (%s)', (locale) => {
  it('fits both translated labels inside separate controls at phone widths and keeps their actions', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 640 }, hasTouch: true })
    try {
      await page.goto(`${origin}/#${locale}`)
      const row = page.getByTestId('native-chat-composer-actions')
      await row.waitFor()
      for (const fontSize of [16, 32]) {
        for (const width of [390, 320, 240]) {
          await page.setViewportSize({ width, height: 480 })
          await row.getByRole('button').evaluateAll((buttons, size) => {
            for (const button of buttons) {
              for (const child of button.querySelectorAll('div, span')) {
                child.style.fontSize = `${size}px`
              }
            }
          }, fontSize)
          const bounds = await row.evaluate((node) => {
            const parent = node.getBoundingClientRect()
            const controls = [...node.children].slice(-2).map((button) => {
              const rect = button.getBoundingClientRect()
              const range = document.createRange()
              range.selectNodeContents(button)
              const text = range.getBoundingClientRect()
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                textLeft: text.left,
                textRight: text.right,
                textTop: text.top,
                textBottom: text.bottom
              }
            })
            const container = node
              .closest('[data-testid="queued-edit-container"]')
              .getBoundingClientRect()
            return {
              left: parent.left,
              right: parent.right,
              containerLeft: container.left,
              containerRight: container.right,
              controls
            }
          })
          expect(bounds.left).toBeGreaterThanOrEqual(bounds.containerLeft)
          expect(bounds.right).toBeLessThanOrEqual(bounds.containerRight)
          for (const button of bounds.controls) {
            expect(button.textLeft).toBeGreaterThanOrEqual(button.left - 1)
            expect(button.textRight).toBeLessThanOrEqual(button.right + 1)
            expect(button.left).toBeGreaterThanOrEqual(bounds.left - 1)
            expect(button.right).toBeLessThanOrEqual(bounds.right + 1)
          }
          const [cancel, save] = bounds.controls
          expect(save.left >= cancel.right || save.top >= cancel.bottom).toBe(true)
        }
      }
      await row.getByRole('button').last().click()
      await expect.poll(() => page.getByTestId('edit-results').textContent()).toBe('1:0')
      await row
        .getByRole('button')
        .nth((await row.getByRole('button').count()) - 2)
        .click()
      await expect.poll(() => page.getByTestId('edit-results').textContent()).toBe('1:1')
    } finally {
      await page.close()
    }
  }, 30_000)
})
