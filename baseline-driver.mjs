import { createRequire } from 'node:module'
import fs from 'node:fs'

const root = '/Users/m4air/orca/workspaces/orca/pr25658-review-qa-3'
const base = '/Users/m4air/orca-qa/pr-25658/remote-released-parent'
const { chromium } = createRequire(`${root}/package.json`)('@playwright/test')
const report = { sha: '4ee3dddb3625ee4966e6e60d3f172f4ed0f30599', screenshots: [], observations: [] }
const browser = await chromium.connectOverCDP('http://127.0.0.1:9441')
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes(':5175/'))
if (!page) throw new Error('baseline renderer missing')
report.identity = await page.evaluate(() => window.api.app.getIdentity())
if (report.identity.devRepoRoot !== root) throw new Error('wrong baseline root')
await page.evaluate(async () => {
  await window.__store.getState().updateSettings({ uiLanguage: 'en', theme: 'dark' })
  const store = window.__store.getState()
  store.openSettingsTarget({ pane: 'appearance', repoId: null })
  store.openSettingsPage()
})
await page.setViewportSize({ width: 1480, height: 1500 })
const chat = page.locator('button[aria-controls="appearance-section-chat"]')
if (await chat.getAttribute('aria-expanded') !== 'true') await chat.click()
await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
for (const state of [{ name: 'dark-default', width: 1480, height: 1500 }, { name: 'narrow-20-18', width: 980, height: 1300 }]) {
  await page.setViewportSize({ width: state.width, height: state.height })
  const path = `${base}/shots/baseline-${state.name}.png`
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
  report.screenshots.push(path)
  report.observations.push({ name: state.name, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) })
}
report.surface = await page.evaluate(() => {
  const preview = document.querySelector('[data-native-chat-appearance-preview]')
  const section = document.querySelector('#appearance-section-chat')
  const inputs = [...section.querySelectorAll('input')].map(input => ({ label: input.getAttribute('aria-label'), value: input.value }))
  return { previewPresent: Boolean(preview), inputs, text: section.textContent?.replace(/\s+/g, ' ').trim() }
})
fs.writeFileSync(`${base}/baseline-geometry.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
