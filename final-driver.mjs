// Final-head CDP-only rendered QA. No OS input or real profile access.
import { createRequire } from 'node:module'
import fs from 'node:fs'

const root = '/Users/m4air/orca/workspaces/orca/pr25658-review-qa'
const base = '/Users/m4air/orca-qa/pr-25658/remote'
const require = createRequire(`${root}/package.json`)
const { chromium } = require('@playwright/test')
const report = { sha: 'ef21e3fc62ec75aa8a605fddb3ac9ee9f3ebc4f8', screenshots: [], results: [], failures: [] }
const browser = await chromium.connectOverCDP('http://127.0.0.1:9603')
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes('127.0.0.1:5176'))
if (!page) throw new Error('final renderer page missing')
page.setDefaultTimeout(20000)

function save() {
  fs.writeFileSync(`${base}/final-geometry.json`, JSON.stringify(report, null, 2))
}
async function record(name, data) {
  report.results.push({ name, ...data })
  save()
}
async function shot(name) {
  const path = `${base}/shots/final-${name}.png`
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
  report.screenshots.push(path)
  await record(`shot-${name}`, { path, bytes: fs.statSync(path).size, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) })
}
async function click(locator, label) {
  await locator.waitFor({ state: 'visible' })
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error(`no visible box: ${label}`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(180)
}
async function chatState() {
  return page.evaluate(() => {
    const preview = document.querySelector('[data-native-chat-appearance-preview]')
    if (!preview) return { present: false }
    const box = preview.getBoundingClientRect()
    const paragraphs = [...preview.querySelectorAll('p')]
    const closing = paragraphs.at(-1)?.getBoundingClientRect()
    const code = preview.querySelector('[data-native-chat-code-content]')?.getBoundingClientRect()
    const column = preview.firstElementChild?.firstElementChild?.getBoundingClientRect()
    const rel = (rect) => rect && ({ top: Math.round(rect.top - box.top), bottom: Math.round(rect.bottom - box.top), fullyInside: rect.top >= box.top && rect.bottom <= box.bottom, width: Math.round(rect.width) })
    return {
      present: true, inert: preview.hasAttribute('inert'), header: preview.previousElementSibling?.textContent?.trim(),
      preview: { width: Math.round(box.width), height: Math.round(box.height) }, columnWidth: column && Math.round(column.width),
      fontSize: preview.style.getPropertyValue('--chat-font-size'), codeFontSize: preview.style.getPropertyValue('--chat-code-font-size'), cap: preview.style.getPropertyValue('--chat-content-max-width'),
      closing: rel(closing), code: rel(code), sample: preview.innerText.slice(0, 500), links: preview.querySelectorAll('a').length
    }
  })
}
async function open() {
  await page.setViewportSize({ width: 1480, height: 1500 })
  await page.waitForFunction(() => window.__store?.getState && window.api?.app?.getIdentity)
  const identity = await page.evaluate(async () => window.api.app.getIdentity())
  await record('identity', { identity, url: page.url() })
  if (identity.devRepoRoot !== root || identity.devBranch !== 'ef21e3fc62') throw new Error(`wrong app identity ${JSON.stringify(identity)}`)
  await page.evaluate(() => { const state = window.__store.getState(); state.openSettingsTarget({ pane: 'appearance', repoId: null }); state.openSettingsPage() })
  const chat = page.locator('button[aria-controls="appearance-section-chat"]')
  await chat.waitFor()
  for (const id of ['interface', 'terminal', 'window']) {
    const button = page.locator(`button[aria-controls="appearance-section-${id}"]`)
    if ((await button.count()) && (await button.getAttribute('aria-expanded')) === 'true') await click(button, `collapse ${id}`)
  }
  if ((await chat.getAttribute('aria-expanded')) !== 'true') await click(chat, 'open chat')
}
async function theme(name) {
  const pane = page.locator('button[aria-controls="appearance-section-interface"]')
  if ((await pane.getAttribute('aria-expanded')) !== 'true') await click(pane, 'open interface')
  await click(page.locator('[role="radiogroup"][aria-label="Theme"] [role="radio"]').filter({ hasText: name }).first(), `theme ${name}`)
  await click(pane, 'close interface')
}
async function size(label, value) {
  const input = page.locator(`#appearance-section-chat input[aria-label="${label}"]`)
  await click(input, label)
  await page.keyboard.press('Meta+a')
  await page.keyboard.type(String(value))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(180)
}
async function width(name) {
  await click(page.locator('[role="radiogroup"][aria-label="Width"] [role="radio"]').filter({ hasText: name }).first(), `width ${name}`)
  await record(`width-${name}`, { state: await chatState() })
}
async function contrast() {
  const slider = page.locator('#appearance-section-chat [role="slider"]')
  await slider.scrollIntoViewIfNeeded()
  const box = await slider.boundingBox()
  if (!box) throw new Error('missing contrast slider')
  const read = () => page.evaluate(() => ({ aria: document.querySelector('#appearance-section-chat [role="slider"]')?.getAttribute('aria-valuenow'), mix: document.querySelector('[data-native-chat-appearance-preview]')?.style.getPropertyValue('--chat-foreground-mix'), saved: window.__store.getState().settings?.nativeChatAppearance?.contrast ?? 100, focused: document.activeElement?.getAttribute('role') }))
  const before = await read()
  await page.mouse.move(box.x + 8, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2, { steps: 10 }); await page.waitForTimeout(120)
  const during = await read()
  await page.mouse.up(); await page.waitForTimeout(120)
  const after = await read()
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight')
  const keyboard = await read()
  await record('contrast', { before, during, after, keyboard, draftChanged: during.mix !== before.mix && during.saved === before.saved, releaseCommitted: after.saved !== during.saved })
}

await open()
await theme('Dark')
await record('dark-default', { state: await chatState() }); await shot('dark-default')
await theme('Light')
await record('light-default', { state: await chatState() }); await shot('light-default')
await theme('Dark')
const matching = page.locator('#appearance-section-chat [role="switch"][aria-label="Match terminal interface"]')
await click(matching, 'match terminal on'); await record('match-on', { checked: await matching.getAttribute('aria-checked'), state: await chatState() }); await shot('match-on')
await click(matching, 'match terminal off'); await record('match-off', { checked: await matching.getAttribute('aria-checked'), state: await chatState() })
await width('Comfortable'); await width('Wide'); await width('Full'); await width('Comfortable')
await contrast()
await size('Text size', 20); await size('Code text size', 18)
await page.setViewportSize({ width: 980, height: 1300 }); await page.waitForTimeout(200)
await record('narrow-20-18', { state: await chatState() }); await shot('narrow-20-18')
await page.setViewportSize({ width: 1600, height: 1500 }); await page.waitForTimeout(200)
await record('wide-20-18', { state: await chatState() }); await shot('wide-20-18')
await page.setViewportSize({ width: 1480, height: 1500 })
for (const language of ['en', 'es', 'fr', 'ja', 'ko', 'zh']) {
  await page.evaluate(async (uiLanguage) => { await window.__store.getState().updateSettings({ uiLanguage }) }, language)
  await page.waitForTimeout(220)
  const state = await chatState()
  await record(`locale-${language}-20-18`, { state })
  if (language === 'ja') await shot('locale-ja-20-18')
}
await page.evaluate(async () => { await window.__store.getState().updateSettings({ uiLanguage: 'en', nativeChatAppearance: undefined }) })
await record('final-default', { state: await chatState() })
save()
console.log(JSON.stringify({ results: report.results.length, screenshots: report.screenshots, failures: report.failures }))
