import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
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
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { View } from 'react-native'
import { MobileNativeChatComposerField } from './src/session/native-chat/composer/MobileNativeChatComposerField.web'
import { publishShellKeyboardSource } from './src/platform/keyboard/keyboard-occlusion'

let keyboardHeight = 0
const listeners = new Set()
if (location.hash !== '#browser') {
  publishShellKeyboardSource({
    read: () => keyboardHeight,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
}
window.setShellKeyboard = (height) => {
  keyboardHeight = height
  listeners.forEach((listener) => listener(height))
}
function Composer() {
  const [state, setState] = useState({ value: '', placeholder: 'Message', dictationPreview: null })
  window.updateComposer = (patch) => setState((previous) => ({ ...previous, ...patch }))
  return <View style={{ flex: 1, padding: 12 }}>
    <MobileNativeChatComposerField
      {...state}
      skillToken={null}
      multiline
      scrollEnabled
      accessibilityLabel="Message"
      onChangeText={(value) => setState((previous) => ({ ...previous, value }))}
    />
  </View>
}
createRoot(document.getElementById('root')).render(<Composer />)
`

const bundles = mobileWebAppDependenciesPresent()
const describeSizing = bundles ? describe : describe.skip
const browsers = new Map()
let scratch
let server
let origin

beforeAll(async () => {
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-composer-sizing-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: { contents: entry, resolveDir: mobileDir, loader: 'tsx', sourcefile: 'composer.tsx' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'composer',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}` +
      `${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}</head><body><div id="root"></div>` +
      '<script type="module" src="/composer.js"></script></body></html>'
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

async function openPage(engine, mode = 'shell') {
  const page = await browsers.get(engine.name).newPage({ viewport: { width: 390, height: 844 } })
  if (mode === 'browser') {
    // Model iOS's shrinking visual viewport; RN Web and our keyboard subscription read it independently.
    await page.addInitScript(() => {
      let keyboard = 0
      const viewport = window.visualViewport
      Object.defineProperty(viewport, 'height', { get: () => window.innerHeight - keyboard })
      window.setVisualKeyboard = (height) => {
        keyboard = height
        viewport.dispatchEvent(new Event('resize'))
      }
    })
  }
  await page.goto(`${origin}/#${mode}`, { waitUntil: 'load' })
  const field = page.getByRole('textbox', { name: 'Message' })
  await field.waitFor({ state: 'visible' })
  return { page, field }
}

function height(field) {
  return field.evaluate((input) => input.getBoundingClientRect().height)
}

describeSizing.each(engines)('web composer sizing in $name', (engine) => {
  it('grows for newlines and wrapping, remeasures width, and shrinks without losing focus', async () => {
    const { page, field } = await openPage(engine)
    try {
      await field.fill('Short draft')
      const compact = await height(field)
      await field.fill('First line\nSecond line\nThird line')
      await expect.poll(() => height(field)).toBeGreaterThan(compact)
      expect(await field.evaluate((input) => input.scrollHeight <= input.clientHeight)).toBe(true)

      await field.fill('Review the mobile composer and keep all draft text visible. '.repeat(4))
      await expect.poll(() => height(field)).toBeGreaterThan(compact * 2)
      const narrow = await height(field)
      await page.setViewportSize({ width: 844, height: 844 })
      await expect.poll(() => height(field)).toBeLessThan(narrow)
      await expect
        .poll(() => field.evaluate((input) => input.scrollHeight - input.clientHeight))
        .toBeLessThanOrEqual(1)
      expect(await field.evaluate((input) => document.activeElement === input)).toBe(true)

      await field.fill('Short draft')
      await expect.poll(() => height(field)).toBe(compact)
    } finally {
      await page.close()
    }
  })

  it('grows for dictation without changing the draft or remounting the focused field', async () => {
    const { page, field } = await openPage(engine)
    try {
      await field.fill('Existing draft')
      const compact = await height(field)
      await page.evaluate(() =>
        window.updateComposer({
          dictationPreview: {
            before: 'Existing draft ',
            text: 'Heard words '.repeat(12),
            after: ''
          }
        })
      )
      await expect.poll(() => height(field)).toBeGreaterThan(compact)
      expect(await field.inputValue()).toBe('Existing draft')
      expect(await field.evaluate((input) => document.activeElement === input)).toBe(true)
      await page.evaluate(() => window.updateComposer({ dictationPreview: null }))
      await expect.poll(() => height(field)).toBe(compact)
    } finally {
      await page.close()
    }
  })
})
