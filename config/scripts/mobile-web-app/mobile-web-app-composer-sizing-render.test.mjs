import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from './preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))
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
import { publishShellKeyboardSource } from './src/platform/keyboard-occlusion'

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
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'composer-sizing-'))
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

const longDraft = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join('\n')

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

  it('fits a wrapping placeholder as fully as the same text entered as a draft', async () => {
    const { page, field } = await openPage(engine)
    try {
      await page.setViewportSize({ width: 320, height: 568 })
      const compact = await height(field)
      const placeholder = 'Describe the changes you want to make to the mobile composer input.'
      await page.evaluate((placeholder) => window.updateComposer({ placeholder }), placeholder)
      await expect.poll(() => height(field)).toBeGreaterThan(compact)
      const placeholderHeight = await height(field)
      await field.fill(placeholder)
      await expect.poll(() => height(field)).toBe(placeholderHeight)
      expect(await field.evaluate((input) => input.scrollHeight <= input.clientHeight)).toBe(true)
      await field.fill('')
      await expect.poll(() => height(field)).toBe(placeholderHeight)
      await page.evaluate(() => window.updateComposer({ placeholder: 'Message' }))
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

  it.each(['shell', 'browser'])(
    'caps and scrolls a long draft as the %s keyboard opens and rotates',
    async (mode) => {
      const { page, field } = await openPage(engine, mode)
      const setKeyboard = (height) =>
        page.evaluate(
          ({ mode, height }) => {
            if (mode === 'shell') {
              window.setShellKeyboard(height)
            } else {
              window.setVisualKeyboard(height)
            }
          },
          { mode, height }
        )
      try {
        await field.fill(longDraft)
        await expect.poll(() => height(field)).toBeCloseTo(295, 0)
        expect(await field.evaluate((input) => input.scrollHeight > input.clientHeight)).toBe(true)
        await setKeyboard(340)
        await expect.poll(() => height(field)).toBeCloseTo(176, 0)
        await field.press('ControlOrMeta+End')
        await field.pressSequentially(' Last word')
        await expect.poll(() => field.evaluate((input) => input.scrollTop)).toBeGreaterThan(0)

        await page.setViewportSize({ width: 844, height: 390 })
        await setKeyboard(250)
        await expect.poll(() => height(field)).toBeCloseTo(49, 0)
        await setKeyboard(0)
        await expect.poll(() => height(field)).toBeCloseTo(137, 0)
        expect(await field.evaluate((input) => document.activeElement === input)).toBe(true)
      } finally {
        await page.close()
      }
    }
  )
})
