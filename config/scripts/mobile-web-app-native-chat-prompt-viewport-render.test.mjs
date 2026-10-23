import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, projectDir } from './mobile-web-app-render-harness.mjs'
import {
  nativeChatPromptViewportFixture,
  PROMPT_QUESTION
} from './mobile-web-app-native-chat-prompt-viewport-fixture.mjs'

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip
const artifactDir = process.env.ORCA_MOBILE_PROMPT_VIEWPORT_ARTIFACT_DIR
let browser = null
let origin = null
let scratch = null
let server = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-native-chat-prompt-viewport-'))
  const outDir = join(scratch, 'bundle')
  const sessionDir = join(projectDir, 'mobile', 'src', 'session')
  await mkdir(outDir)
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    plugins: [
      ...mobileWebAppBuildOptions([]).plugins,
      {
        name: 'session-boundary-fixture',
        setup(build) {
          build.onLoad({ filter: /MobileSession(Header|ContentRow|Sheets)\.tsx$/ }, ({ path }) => ({
            loader: 'tsx',
            contents: path.endsWith('MobileSessionHeader.tsx')
              ? `import React from 'react'; import { View } from 'react-native'; export function MobileSessionHeader({ controller }) { return <View testID="session-header" style={{ height: controller.fixtureChromeHeight, flexShrink: 0 }} /> }`
              : path.endsWith('MobileSessionContentRow.tsx')
                ? `export function MobileSessionContentRow({ controller }) { return controller.fixtureContent }`
                : `export function MobileSessionSheets() { return null }`
          }))
        }
      }
    ],
    entryPoints: undefined,
    entryNames: 'app',
    stdin: {
      contents: nativeChatPromptViewportFixture({
        chatViewModule: join(sessionDir, 'MobileNativeChatView'),
        sessionSurfaceModule: join(sessionDir, 'MobileSessionSurface'),
        clientContextModule: join(sessionDir, '../transport/client-context.web')
      }),
      resolveDir: sessionDir,
      loader: 'tsx',
      sourcefile: 'native-chat-prompt-viewport.tsx'
    },
    outdir: outDir,
    splitting: false,
    write: true,
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      ${MOBILE_WEB_APP_ROOT_RESET}${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}
      </head><body><div id="root" style="display:flex;flex-direction:column;height:100dvh"></div>
      <script type="module" src="/app.js"></script></body></html>`
  )
  const served = await createBundleServer({ outDir })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true })
  }
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openPrompt(viewport, query = '') {
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/${query}`)
  await page
    .getByText(
      query.includes('terminal')
        ? 'Answer this OMP question in the terminal.'
        : query.includes('short')
          ? 'Continue?'
          : PROMPT_QUESTION,
      { exact: true }
    )
    .waitFor()
  return { page, errors }
}

async function readPromptLayout(page, footerLabel = 'Submit') {
  return page.evaluate(
    ({ footerLabel }) => {
      const rect = (node) => {
        if (!node) {
          throw new Error('Missing chat layout element')
        }
        const { top, bottom, height } = node.getBoundingClientRect()
        return {
          top,
          bottom,
          height,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight
        }
      }
      const chat = document.querySelector('[data-testid="native-chat-conversation-context"]')
      const prompt = document.querySelector('[data-testid="native-chat-ask-body"]')
      const header = document.querySelector('[data-testid="native-chat-ask-header"]')
      const text = [...document.querySelectorAll('*')].find(
        (node) => node.childElementCount === 0 && node.textContent === footerLabel
      )
      const cancel = [...document.querySelectorAll('*')].find(
        (node) => node.childElementCount === 0 && node.textContent === 'Cancel'
      )
      return {
        chat: rect(chat),
        header: rect(header),
        prompt: rect(prompt),
        footerInScroll: prompt.contains(text?.parentElement),
        inlineActions: header.contains(text?.parentElement),
        footer: rect(text?.parentElement?.parentElement),
        submit: rect(text?.parentElement),
        cancel: rect(cancel?.parentElement),
        composer: rect(document.querySelector('[data-testid="native-chat-composer-inset"]')),
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight
      }
    },
    { footerLabel }
  )
}

async function recordLayout(page, name, layout) {
  if (!artifactDir) {
    return
  }
  await writeFile(join(artifactDir, `${name}.json`), JSON.stringify(layout, null, 2))
  await page.screenshot({ path: join(artifactDir, `${name}.png`) })
}

async function scrollQuestionToEnd(page) {
  return page.evaluate(() => {
    const prompt = document.querySelector('[data-testid="native-chat-ask-body"]')
    prompt.scrollTop = prompt.scrollHeight
    return prompt.scrollTop
  })
}

const CASES = [
  { width: 375, height: 650, keyboard: 0 },
  { width: 315, height: 540, keyboard: 0 },
  { width: 375, height: 350, keyboard: 0 },
  { width: 375, height: 650, keyboard: 300 },
  { width: 874, height: 402, keyboard: 0 },
  { width: 375, height: 350, keyboard: 0, steps: true }
]

const INSET_CASES = [
  { width: 375, height: 650, keyboard: 300, bottom: 34, chrome: 0 },
  { width: 375, height: 650, keyboard: 250, bottom: 34, chrome: 88 },
  { width: 375, height: 650, keyboard: 300, bottom: 34, chrome: 88 }
]

const composerField = (page) =>
  page.getByPlaceholder('Ask anything, @ to mention files, / for commands')
const answerField = (page) => page.getByPlaceholder('Type your answer', { exact: true })
const viewConversation = (page) =>
  page.getByRole('button', { name: 'View conversation', exact: true })

describeRender('native chat question answering surface', () => {
  it('preserves composer identity, attachments and answer drafts through context viewing and rotation', async () => {
    const { page, errors } = await openPrompt(
      { width: 402, height: 874 },
      '?keyboard=208&bottom=21&chrome=62&attachment=1'
    )
    try {
      const composer = composerField(page)
      expect(await composer.isVisible()).toBe(false)
      await viewConversation(page).click({ timeout: 3000 })
      await composer.fill('Draft survives rotation\n'.repeat(8))
      await composer.evaluate((node) => {
        node.dataset.rotationWitness = 'same-field'
      })
      expect(await page.getByLabel('Remove image', { exact: true }).isVisible()).toBe(true)
      await page.getByLabel('Expand', { exact: true }).click({ timeout: 3000 })
      await page.getByText('Other…', { exact: true }).click()
      await answerField(page).fill('Keep context')
      await page.setViewportSize({ width: 874, height: 402 })
      await expect.poll(async () => (await readPromptLayout(page)).chat.height).toBe(0)
      await expect
        .poll(async () => (await readPromptLayout(page)).prompt.height)
        .toBeGreaterThanOrEqual(44)
      const layout = await readPromptLayout(page)
      expect(
        layout.prompt.height,
        'editing viewport above tall landscape IME'
      ).toBeGreaterThanOrEqual(44)
      expect(layout.composer.height).toBe(0)
      expect(layout.header.bottom).toBeLessThanOrEqual(402 - 208 - 21)
      expect(layout.documentHeight).toBeLessThanOrEqual(402)
      await answerField(page).fill('Edited in landscape')
      const input = await answerField(page).boundingBox()
      expect(input.height).toBeGreaterThanOrEqual(44)
      await expect
        .poll(async () => {
          const box = await answerField(page).boundingBox()
          const body = await page.getByTestId('native-chat-ask-body').boundingBox()
          return box.y + box.height <= body.y + body.height + 1 && box.y >= body.y - 1
        })
        .toBe(true)
      await viewConversation(page).click({ timeout: 3000 })
      expect(await composer.getAttribute('data-rotation-witness')).toBe('same-field')
      expect(await composer.inputValue()).toBe('Draft survives rotation\n'.repeat(8))
      expect(await page.getByLabel('Remove image', { exact: true }).isVisible()).toBe(true)
      expect(await page.evaluate(() => globalThis.__orcaPromptViewportAnswers)).toBeUndefined()
      await page.getByLabel('Expand', { exact: true }).click({ timeout: 3000 })
      expect(await answerField(page).inputValue()).toBe('Edited in landscape')
      await recordLayout(page, 'landscape-keyboard-answer-controls', await readPromptLayout(page))
      await page.setViewportSize({ width: 402, height: 874 })
      expect(await answerField(page).inputValue()).toBe('Edited in landscape')
      await recordLayout(page, 'portrait-keyboard-answer', await readPromptLayout(page))
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('reclaims session chrome above a small landscape IME and restores it with the drafts', async () => {
    const { page, errors } = await openPrompt(
      { width: 640, height: 360 },
      '?surface=1&keyboard=239&chrome=69&top=24'
    )
    try {
      expect(await page.getByTestId('session-header').isVisible()).toBe(false)
      await scrollQuestionToEnd(page)
      await page.getByText('Other…', { exact: true }).click({ timeout: 3000 })
      await answerField(page).fill('Small phone answer', { timeout: 3000 })
      await expect
        .poll(async () => {
          const input = await answerField(page).boundingBox()
          const body = await page.getByTestId('native-chat-ask-body').boundingBox()
          return (
            input.height >= 44 &&
            input.y >= body.y - 1 &&
            input.y + input.height <= body.y + body.height + 1
          )
        })
        .toBe(true)
      const layout = await readPromptLayout(page)
      expect(layout.inlineActions).toBe(true)
      expect(layout.submit.height).toBeGreaterThanOrEqual(44)
      expect(layout.submit.bottom).toBeLessThanOrEqual(360 - 239)
      expect(await viewConversation(page).isVisible()).toBe(true)
      await recordLayout(page, '640-360-native-sized-keyboard', layout)
      await viewConversation(page).click({ timeout: 3000 })
      await expect.poll(() => page.getByTestId('session-header').isVisible()).toBe(true)
      await composerField(page).fill('Retained message', { timeout: 3000 })
      await page.getByLabel('Expand', { exact: true }).click({ timeout: 3000 })
      expect(await page.getByTestId('session-header').isVisible()).toBe(false)
      expect(await answerField(page).inputValue()).toBe('Small phone answer')
      expect(await page.evaluate(() => globalThis.__orcaPromptViewportAnswers)).toBeUndefined()
      await page.setViewportSize({ width: 360, height: 640 })
      await expect.poll(() => page.getByTestId('session-header').isVisible()).toBe(true)
      await viewConversation(page).click({ timeout: 3000 })
      expect(await composerField(page).inputValue()).toBe('Retained message')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it.each(['mic', 'terminal', 'hiddenchat'])(
    'retains session navigation when answering cannot own the composer: %s',
    async (state) => {
      const { page, errors } = await openPrompt(
        { width: 640, height: 360 },
        `?surface=1&keyboard=239&chrome=69&top=24&${state}=1`
      )
      try {
        expect(await page.getByTestId('session-header').isVisible()).toBe(true)
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  )

  it('keeps question controls inside landscape notch insets', async () => {
    const { page, errors } = await openPrompt(
      { width: 874, height: 402 },
      '?surface=1&keyboard=208&chrome=62&top=0&left=59&right=59&bottom=21'
    )
    try {
      await scrollQuestionToEnd(page)
      await page.getByText('Other…', { exact: true }).click({ timeout: 3000 })
      await answerField(page).fill('Safe beside the notch')
      for (const control of [
        answerField(page),
        viewConversation(page),
        page.getByText('Submit', { exact: true })
      ]) {
        const rect = await control.boundingBox()
        expect(rect.x).toBeGreaterThanOrEqual(59)
        expect(rect.x + rect.width).toBeLessThanOrEqual(874 - 59 + 1)
        expect(rect.y + rect.height).toBeLessThanOrEqual(402 - 208 - 21 + 1)
      }
      await recordLayout(page, 'landscape-notch-answering', await readPromptLayout(page))
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('keeps terminal-only question navigation reachable above the keyboard', async () => {
    const { page, errors } = await openPrompt(
      { width: 375, height: 650 },
      '?terminal=1&keyboard=300&bottom=34&chrome=88'
    )
    try {
      const answer = page.getByRole('button', { name: 'Answer in terminal', exact: true })
      await answer.click()
      expect(await page.evaluate(() => globalThis.__orcaPromptViewportTerminalNavigations)).toBe(1)
      const layout = await answer.boundingBox()
      expect(layout.y + layout.height).toBeLessThanOrEqual(650 - 300 - 34)
      expect(await composerField(page).isVisible()).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it.each(INSET_CASES)(
    'reserves readable answering space with safe area $bottom, keyboard $keyboard and chrome $chrome',
    async ({ width, height, keyboard, bottom, chrome }) => {
      const { page, errors } = await openPrompt(
        { width, height },
        `?keyboard=${keyboard}&bottom=${bottom}&chrome=${chrome}`
      )
      try {
        const layout = await readPromptLayout(page)
        expect(
          layout.prompt.height,
          'answer body has room beyond one touch target'
        ).toBeGreaterThanOrEqual(100)
        expect(layout.chat.height).toBe(0)
        expect(layout.composer.height).toBe(0)
        expect(layout.footerInScroll).toBe(false)
        expect(layout.submit.bottom).toBeLessThanOrEqual(height - keyboard - bottom + 1)
        expect(layout.header.top).toBeGreaterThanOrEqual(chrome)
        expect(layout.documentHeight).toBeLessThanOrEqual(height)
        await page.getByText('Other…', { exact: true }).click()
        await answerField(page).fill('Readable above the keyboard')
        const input = await answerField(page).boundingBox()
        expect(input.y + input.height).toBeLessThanOrEqual(layout.footer.top + 1)
        expect(input.y).toBeGreaterThanOrEqual(layout.header.bottom - 1)
        expect(await viewConversation(page).isVisible()).toBe(true)
        await recordLayout(
          page,
          `${width}-${height}-keyboard-${keyboard}-chrome-${chrome}-editing`,
          await readPromptLayout(page)
        )
        await page.getByText('Submit', { exact: true }).click({ timeout: 3000 })
        expect(await page.evaluate(() => globalThis.__orcaPromptViewportAnswers)).toEqual([
          { indices: [], other: 'Readable above the keyboard' }
        ])
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  )

  it.each(CASES)(
    'keeps one answer surface in $width×$height with keyboard $keyboard and steps $steps',
    async ({ width, height, keyboard, steps }) => {
      const { page, errors } = await openPrompt(
        { width, height },
        `?keyboard=${keyboard}${steps ? '&steps=2' : ''}`
      )
      try {
        const layout = await readPromptLayout(page, steps ? 'Next' : 'Submit')
        expect(layout.composer.height).toBe(0)
        expect(layout.prompt.height).toBeGreaterThanOrEqual(44)
        expect(layout.prompt.scrollHeight).toBeGreaterThanOrEqual(layout.prompt.clientHeight)
        expect(layout.header.bottom).toBeLessThanOrEqual(layout.prompt.top + 1)
        expect(layout.prompt.bottom).toBeLessThanOrEqual(layout.footer.top + 1)
        expect(layout.submit.bottom).toBeLessThanOrEqual(height - keyboard + 1)
        if (!keyboard && (width < height || width < 568)) {
          expect(layout.chat.height).toBeGreaterThanOrEqual(height * 0.35 - 1)
        } else {
          expect(layout.chat.height).toBe(0)
        }
        await recordLayout(
          page,
          `${width}-${height}-keyboard-${keyboard}${steps ? '-steps' : ''}`,
          layout
        )
        expect(await scrollQuestionToEnd(page)).toBe(
          layout.prompt.scrollHeight - layout.prompt.clientHeight
        )
        expect((await readPromptLayout(page, steps ? 'Next' : 'Submit')).header).toEqual(
          layout.header
        )
        expect((await readPromptLayout(page, steps ? 'Next' : 'Submit')).footer).toEqual(
          layout.footer
        )
        expect(layout.documentHeight).toBeLessThanOrEqual(height)
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  )

  it('combines actions and context in short landscape and restores the footer after rotating', async () => {
    const { page, errors } = await openPrompt(
      { width: 874, height: 402 },
      '?keyboard=225&bottom=21&chrome=62'
    )
    try {
      await recordLayout(page, 'exceptionally-short-slot', await readPromptLayout(page))
      await expect.poll(async () => (await readPromptLayout(page)).inlineActions).toBe(true)
      expect((await readPromptLayout(page)).prompt.height).toBeGreaterThanOrEqual(44)
      await page.getByText('Persist across reload', { exact: true }).click({ timeout: 3000 })
      await page.getByText('Submit', { exact: true }).click({ timeout: 3000 })
      expect(await page.evaluate(() => globalThis.__orcaPromptViewportAnswers)).toEqual([
        { indices: [0] }
      ])
      await viewConversation(page).click({ timeout: 3000 })
      expect(await page.getByTestId('native-chat-prompt-strip').isVisible()).toBe(true)
      await page.getByLabel('Expand', { exact: true }).click({ timeout: 3000 })
      await page.setViewportSize({ width: 402, height: 874 })
      await expect.poll(async () => (await readPromptLayout(page)).inlineActions).toBe(false)
      const expanded = await readPromptLayout(page)
      expect(expanded.prompt.height).toBeGreaterThanOrEqual(100)
      await page.setViewportSize({ width: 874, height: 402 })
      await expect.poll(async () => (await readPromptLayout(page)).inlineActions).toBe(true)
      const settled = await readPromptLayout(page)
      for (let frame = 0; frame < 4; frame++) {
        await page.evaluate(() => new Promise(requestAnimationFrame))
        expect(await readPromptLayout(page)).toEqual(settled)
      }
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('keeps a short question compact while retaining conversation context', async () => {
    const { page, errors } = await openPrompt({ width: 375, height: 900 }, '?short=1')
    try {
      const chat = await page.getByTestId('native-chat-conversation-context').boundingBox()
      expect(chat.height).toBeGreaterThan(550)
      expect(await composerField(page).isVisible()).toBe(false)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('resets each wizard page to its question while retaining revisited selections and text', async () => {
    const { page, errors } = await openPrompt({ width: 375, height: 650 }, '?steps=2&keyboard=300')
    try {
      await page.getByText('Other…', { exact: true }).click()
      await answerField(page).fill('First answer draft')
      await page.getByText('Next', { exact: true }).click()
      await expect
        .poll(async () =>
          page.getByTestId('native-chat-ask-body').evaluate((node) => node.scrollTop)
        )
        .toBe(0)
      await page.getByText('Session only', { exact: true }).click()
      await page.getByRole('tab', { name: 'Workspace', exact: true }).click()
      expect(await answerField(page).inputValue()).toBe('First answer draft')
      await page.getByRole('tab', { name: 'Details', exact: true }).click()
      await page.getByText('Submit', { exact: true }).click({ timeout: 3000 })
      expect(await page.evaluate(() => globalThis.__orcaPromptViewportAnswers)).toEqual([
        { indices: [], other: 'First answer draft' },
        { indices: [1] }
      ])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })
})
