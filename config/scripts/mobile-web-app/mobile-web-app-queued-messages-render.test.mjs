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
import { SUPPORTED_UI_LOCALES } from '../../../src/shared/ui-locale.ts'

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
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileNativeChatQueuedMessages } from './src/session/native-chat/input/MobileNativeChatQueuedMessages'
import { MobileNativeChatComposer } from './src/session/native-chat/composer/MobileNativeChatComposer'
import { mobileQueuedMessageCards } from './src/session/mobile-structured-queued-message-cards'
import { activateMobileUiLocale, translate } from './src/i18n/mobile-i18n'

const [mode, locale] = location.hash.slice(1).split(':')
const texts = ['First queued message', 'Review the mobile transcript and keep every detail. '.repeat(30)]
function Queue() {
  const messages = texts.map((text, index) => ({
    messageId: 'message-' + index,
    position: index + 1,
    state: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }))
  return <View style={{ flex: 1, justifyContent: 'flex-end' }}>
    <MobileNativeChatQueuedMessages
      cards={mobileQueuedMessageCards(messages, [], { agentWorking: true })}
      onMove={mode === 'drag' ? async () => true : undefined}
    />
  </View>
}
function Editor() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void activateMobileUiLocale(locale).then(() => {
      window.actionLabels = {
        cancel: translate('chat.composer.cancelEditing', 'Cancel editing'),
        save: translate('chat.composer.saveEditedMessage', 'Save edited message')
      }
      setReady(true)
    })
  }, [])
  return ready ? <View style={{ flex: 1, justifyContent: 'flex-end', marginHorizontal: 16 }}>
    <MobileNativeChatComposer
      value="Edited message"
      onChangeText={() => {}}
      onSend={async () => true}
      editSession={{ cancel: () => {}, refuseCommand: () => false, locked: false }}
      sendSurfaceId="editor"
      getSendCompletionGeneration={() => 0}
      getComposerEditGeneration={() => 0}
      onAttachImage={() => {}}
      onMicPress={() => {}}
    />
  </View> : null
}
createRoot(document.getElementById('root')).render(
  <GestureHandlerRootView style={{ flex: 1 }}>{mode === 'editor' ? <Editor /> : <Queue />}</GestureHandlerRootView>
)
`

const bundles = mobileWebAppDependenciesPresent()
const describeLayout = bundles ? describe : describe.skip
const browsers = new Map()
let scratch
let server
let origin

beforeAll(async () => {
  if (!bundles) {
    return
  }
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'queued-messages-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: { contents: entry, resolveDir: mobileDir, loader: 'tsx', sourcefile: 'queued.tsx' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'queued',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}` +
      `${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}</head><body><div id="root"></div>` +
      '<script type="module" src="/queued.js"></script></body></html>'
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

async function openPage(engine, hash, width) {
  const page = await browsers.get(engine.name).newPage({ viewport: { width, height: 700 } })
  await page.goto(`${origin}/#${hash}`, { waitUntil: 'load' })
  return page
}

function editorActionProblems(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="native-chat-composer-actions"]')
    const problems = []
    const [cancel, save] = ['cancel', 'save'].map((name) => {
      const button = row.querySelector(`[aria-label="${window.actionLabels[name]}"]`)
      const label = button.querySelector('div[dir]')
      const range = document.createRange()
      range.selectNodeContents(label)
      const text = range.getBoundingClientRect()
      const box = button.getBoundingClientRect()
      if (label.scrollWidth > label.clientWidth) {
        problems.push(`${name} label truncated`)
      }
      if (text.left < box.left - 0.5 || text.right > box.right + 0.5) {
        problems.push(`${name} label outside its button`)
      }
      return box
    })
    if (cancel.right > save.left + 0.5) {
      problems.push('cancel overlaps save')
    }
    if (save.right > row.getBoundingClientRect().right + 0.5) {
      problems.push('save past the row')
    }
    return problems
  })
}

describeLayout.each(engines)('mobile queued messages in $name', (engine) => {
  it.each(['plain', 'drag'])('scrolls only as far as the %s rows reach', async (mode) => {
    const page = await openPage(engine, mode, 390)
    try {
      await page.locator('[data-testid="queued-card-row"]').nth(1).waitFor()
      const range = () =>
        page.evaluate(() => {
          const box = document.querySelector('[data-testid="queued-box"]')
          const rows = [...box.querySelectorAll('[data-testid="queued-card-row"]')]
          const scroller = [...box.querySelectorAll('*')].find(
            (node) => getComputedStyle(node).overflowY === 'auto'
          )
          const rowsHeight = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)
          return scroller.scrollHeight - rowsHeight
        })
      await expect.poll(range).toBeLessThanOrEqual(1)
    } finally {
      await page.close()
    }
  })

  it('fits whole Save and Cancel labels at 360pt in every shipped locale', async () => {
    const results = await Promise.all(
      SUPPORTED_UI_LOCALES.map(async (locale) => {
        const page = await openPage(engine, `editor:${locale}`, 360)
        try {
          await page.locator('[data-testid="native-chat-composer-actions"]').waitFor()
          return { locale, problems: await editorActionProblems(page) }
        } finally {
          await page.close()
        }
      })
    )
    expect(results.filter(({ problems }) => problems.length > 0)).toEqual([])
  }, 60_000)
})
