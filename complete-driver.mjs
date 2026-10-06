import { createRequire } from 'node:module'
import fs from 'node:fs'
const root = '/Users/m4air/orca/workspaces/orca/pr25658-review-qa-2'
const base = '/Users/m4air/orca-qa/pr-25658/remote'
const { chromium } = createRequire(`${root}/package.json`)('@playwright/test')
const report = { sha: '354c3efb70d0214bf8a9bdb44aab7baf50d4ae65', results: [], screenshots: [], failures: [] }
const save = () => fs.writeFileSync(`${base}/complete-geometry.json`, JSON.stringify(report, null, 2))
const assert = (truth, message) => { if (!truth) throw new Error(message) }
let page
async function state() {
  return page.evaluate(() => {
    const p = document.querySelector('[data-native-chat-appearance-preview]')
    if (!p) return { previewMissing: true }
    const b = p.getBoundingClientRect(), c = p.firstElementChild.firstElementChild.getBoundingClientRect()
    const closing = [...p.querySelectorAll('p')].at(-1).getBoundingClientRect()
    const css = getComputedStyle(p), saved = window.__store.getState().settings
    const slider = document.querySelector('#appearance-section-chat [role="slider"]')
    return {
      viewport: { width: innerWidth, height: innerHeight },
      preview: { top: b.top, bottom: b.bottom, width: b.width, height: b.height }, columnWidth: c.width,
      closing: { top: closing.top - b.top, bottom: closing.bottom - b.top, fullyInside: closing.bottom <= b.bottom },
      fontSize: css.getPropertyValue('--chat-font-size').trim(), codeFontSize: css.getPropertyValue('--chat-code-font-size').trim(),
      cap: css.getPropertyValue('--chat-content-max-width').trim(), mix: css.getPropertyValue('--chat-foreground-mix').trim(),
      fontFamily: css.getPropertyValue('--chat-font-family').trim(),
      saved: saved.nativeChatAppearance ?? null, savedContrast: saved.nativeChatAppearance?.contrast ?? 100,
      aria: Number(slider?.getAttribute('aria-valuenow')), focused: document.activeElement === slider,
      language: saved.uiLanguage, inert: p.hasAttribute('inert'), links: p.querySelectorAll('a').length
    }
  })
}
async function record(name, extra = {}) { report.results.push({ name, state: await state(), ...extra }); save() }
async function frame() {
  const header = page.locator('button[aria-controls="appearance-section-chat"]')
  await header.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function shot(name) {
  await frame()
  const s = await state()
  assert(s.preview.top >= 0 && s.preview.bottom <= s.viewport.height, `preview outside screenshot: ${name}`)
  const path = `${base}/shots/complete-${name}.png`
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
  report.screenshots.push(path); await record(`shot-${name}`, { path })
}
async function click(locator) { await locator.scrollIntoViewIfNeeded(); await locator.click() }
async function waitSaved(key, value) {
  await page.waitForFunction(({ key, value }) => {
    const current = window.__store.getState().settings?.nativeChatAppearance?.[key]
    return (key === 'matchTerminalInterface' ? current === true : current) === value
  }, { key, value })
}
async function defaultWait() {
  await page.waitForFunction(() => {
    const p = document.querySelector('[data-native-chat-appearance-preview]')
    const a = window.__store.getState().settings?.nativeChatAppearance
    return p?.style.getPropertyValue('--chat-font-size') === '14px' && p?.style.getPropertyValue('--chat-code-font-size') === '12px' && (a?.contrast ?? 100) === 100 && !a?.matchTerminalInterface
  })
}
async function reset() { await click(page.locator('#appearance-section-chat').getByRole('button', { name: 'Reset', exact: true })); await defaultWait() }
async function theme(name) {
  const header = page.locator('button[aria-controls="appearance-section-interface"]')
  if (await header.getAttribute('aria-expanded') !== 'true') await click(header)
  await click(page.locator('[role="radiogroup"][aria-label="Theme"]').getByRole('radio', { name, exact: true }))
  await page.waitForFunction(name => window.__store.getState().settings?.theme === name.toLowerCase(), name)
  await click(header)
}
async function size(label, value, key, cssKey) {
  const input = page.locator(`#appearance-section-chat input[aria-label="${label}"]`)
  await input.fill(String(value)); await input.press('Enter'); await waitSaved(key, value)
  await page.waitForFunction(({ cssKey, value }) => document.querySelector('[data-native-chat-appearance-preview]').style.getPropertyValue(cssKey) === `${value}px`, { cssKey, value })
}
async function holdDrag(fraction) {
  const slider = page.locator('#appearance-section-chat [role="slider"]')
  await slider.scrollIntoViewIfNeeded()
  const thumb = await slider.boundingBox(), track = await page.locator('#appearance-section-chat [data-slot="slider"]').boundingBox()
  assert(thumb && track, 'missing scoped contrast thumb/track')
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width * fraction, thumb.y + thumb.height / 2, { steps: 8 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
try {
  fs.mkdirSync(`${base}/shots`, { recursive: true })
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9441')
  page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':5174/'))
  assert(page, 'intended renderer missing'); page.setDefaultTimeout(15000)
  report.identity = await page.evaluate(() => window.api.app.getIdentity())
  assert(report.identity.devRepoRoot === root, 'wrong app root')
  await page.evaluate(async () => { await window.__store.getState().updateSettings({ uiLanguage: 'en' }); const s = window.__store.getState(); s.openSettingsTarget({ pane: 'appearance', repoId: null }); s.openSettingsPage() })
  await page.setViewportSize({ width: 1480, height: 1500 })
  for (const id of ['interface', 'terminal', 'window']) {
    const header = page.locator(`button[aria-controls="appearance-section-${id}"]`)
    if (await header.count() && await header.getAttribute('aria-expanded') === 'true') await click(header)
  }
  const chat = page.locator('button[aria-controls="appearance-section-chat"]')
  if (await chat.getAttribute('aria-expanded') !== 'true') await click(chat)
  await reset()
  await theme('Dark'); await shot('dark-default')
  await theme('Light'); await shot('light-default')
  await theme('Dark')
  const matching = page.locator('#appearance-section-chat [role="switch"]')
  await click(matching); await waitSaved('matchTerminalInterface', true)
  await record('matching-on'); await shot('matching-on')
  await click(matching); await waitSaved('matchTerminalInterface', false); await record('matching-off')
  for (const name of ['Comfortable', 'Wide', 'Full']) {
    await click(page.locator('[role="radiogroup"][aria-label="Width"]').getByRole('radio', { name, exact: true }))
    const expected = name === 'Comfortable' ? '46rem' : name === 'Wide' ? '60rem' : 'none'
    await page.waitForFunction(cap => document.querySelector('[data-native-chat-appearance-preview]').style.getPropertyValue('--chat-content-max-width') === cap, expected)
    await record(`width-${name}`)
  }
  await reset()
  const before = await state(); await holdDrag(0.82); const during = await state()
  assert(during.mix !== before.mix && during.aria !== before.aria, 'held drag did not update preview')
  assert(during.savedContrast === before.savedContrast, 'held drag saved before release')
  await page.mouse.up(); await waitSaved('contrast', during.aria); const after = await state()
  assert(after.savedContrast === during.aria, 'release did not publish saved contrast')
  report.contrast = { before, during, after }; await record('contrast-release')
  const slider = page.locator('#appearance-section-chat [role="slider"]')
  await slider.press('ArrowLeft'); const left = Number(await slider.getAttribute('aria-valuenow')); await waitSaved('contrast', left)
  await slider.press('ArrowRight'); const right = Number(await slider.getAttribute('aria-valuenow')); await waitSaved('contrast', right)
  assert((await state()).focused, 'keyboard commit lost thumb focus'); await record('contrast-keyboard')
  await reset(); await record('reset-after-commit')
  const defaultBefore = await state(); await holdDrag(0.74); const held = await state()
  assert(held.savedContrast === 100 && held.aria !== 100 && held.mix !== defaultBefore.mix, 'default-saved draft not created')
  const resetButton = page.locator('#appearance-section-chat').getByRole('button', { name: 'Reset', exact: true })
  await resetButton.focus(); await page.keyboard.press('Enter')
  await page.waitForFunction(() => Number(document.querySelector('#appearance-section-chat [role="slider"]').getAttribute('aria-valuenow')) === 100)
  const cleared = await state(); assert(cleared.mix === defaultBefore.mix && cleared.savedContrast === 100, 'Reset did not cancel unsaved draft')
  await page.mouse.up(); await defaultWait(); report.resetDraft = { defaultBefore, held, cleared, afterRelease: await state(), activation: 'keyboard Enter on the real Reset button while pointer remained held' }; await record('reset-default-draft')
  await page.evaluate(() => { window.__qaPreviewNode = document.querySelector('[data-native-chat-appearance-preview]') })
  await click(chat)
  await page.waitForFunction(() => document.querySelector('button[aria-controls="appearance-section-chat"]')?.getAttribute('aria-expanded') === 'false')
  assert(await page.evaluate(() => window.__qaPreviewNode === document.querySelector('[data-native-chat-appearance-preview]')), 'collapse removed preview node')
  await click(chat)
  await page.waitForFunction(() => document.querySelector('button[aria-controls="appearance-section-chat"]')?.getAttribute('aria-expanded') === 'true')
  await page.locator('[data-native-chat-appearance-preview]').waitFor({ state: 'visible' })
  const retained = await page.evaluate(() => window.__qaPreviewNode === document.querySelector('[data-native-chat-appearance-preview]'))
  assert(retained, 'collapse replaced preview node'); await record('collapse-reopen', { retained })
  const tabsBefore = browser.contexts().flatMap(c => c.pages()).length
  const preview = page.locator('[data-native-chat-appearance-preview]'); await frame()
  const previewBox = await preview.boundingBox(); assert(previewBox, 'missing inert preview box')
  assert((await state()).inert && (await state()).links === 0, 'sample inertness changed'); await record('inert-contextmenu-deferred', { tabsBefore, tabsAfter: browser.contexts().flatMap(c => c.pages()).length })
  if (await chat.getAttribute('aria-expanded') !== 'true') await click(chat); await page.locator('[data-native-chat-appearance-preview]').waitFor({ state: 'visible' }); await size('Text size', 20, 'fontSize', '--chat-font-size'); await size('Code text size', 18, 'codeFontSize', '--chat-code-font-size')
  await page.setViewportSize({ width: 980, height: 1300 }); await shot('narrow-20-18')
  await page.setViewportSize({ width: 1600, height: 1500 }); await shot('wide-20-18')
  await page.setViewportSize({ width: 1480, height: 1500 })
  for (const language of ['en', 'es', 'fr', 'ja', 'ko', 'zh']) {
    await page.evaluate(async uiLanguage => { await window.__store.getState().updateSettings({ uiLanguage }) }, language)
    await page.waitForFunction(language => window.__store.getState().settings?.uiLanguage === language, language)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await shot(`locale-${language}-20-18`)
  }
  await page.evaluate(async () => { await window.__store.getState().updateSettings({ uiLanguage: 'en' }) })
  await reset(); await shot('reset-final-default'); save()
  console.log(JSON.stringify({ result: 'passed', results: report.results.length, screenshots: report.screenshots, sha: report.sha }))
  process.exit(0)
} catch (error) {
  report.failures.push({ message: String(error), stack: error?.stack }); save()
  console.error(error); process.exit(1)
}
