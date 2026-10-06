import { createRequire } from 'node:module'
import fs from 'node:fs'

const root = '/Users/m4air/orca/workspaces/orca/pr25658-review-qa-3'
const base = '/Users/m4air/orca-qa/pr-25658/remote-released-parent/main-verified'
const { chromium } = createRequire(`${root}/package.json`)('@playwright/test')
const report = { sha: 'ccc0bf70e46ea33b1f9d735942de9d2a71664cd2', screenshots: [], records: [] }
const browser = await chromium.connectOverCDP('http://127.0.0.1:9441')
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes(':5175/'))
if (!page) throw new Error('main renderer missing')
page.setDefaultTimeout(15000)
report.identity = await page.evaluate(() => window.api.app.getIdentity())
if (report.identity.devRepoRoot !== root) throw new Error('wrong main root')
const snapshot = async name => {
  const path = `${base}/main-${name}.png`
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
  report.screenshots.push(path)
  const state = await page.evaluate(() => {
    const section = document.querySelector('#appearance-section-chat')
    const preview = document.querySelector('[data-native-chat-appearance-preview]')
    return {
      viewport: { width: innerWidth, height: innerHeight },
      previewPresent: Boolean(preview),
      chatControlsPresent: Boolean(section),
      inputs: [...section?.querySelectorAll('input') ?? []].map(input => ({ label: input.getAttribute('aria-label'), value: input.value })),
      text: section?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      appearanceHeading: [...document.querySelectorAll('h1, h2')].map(node => node.textContent?.trim()).filter(Boolean)
    }
  })
  report.records.push({ name, state })
}
fs.mkdirSync(base, { recursive: true })
await page.evaluate(async () => {
  await window.__store.getState().updateSettings({ uiLanguage: 'en', theme: 'dark' })
  const store = window.__store.getState()
  store.openSettingsTarget({ pane: 'appearance', repoId: null })
  store.openSettingsPage()
})
await page.setViewportSize({ width: 1480, height: 1500 })
await page.waitForFunction(() => document.querySelector('h1, h2'))
await snapshot('dark-default-14-12')
await page.setViewportSize({ width: 980, height: 1300 })
await snapshot('narrow-20-18')
fs.writeFileSync(`${base}/main-geometry.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ result: 'passed', ...report }))
process.exit(0)
