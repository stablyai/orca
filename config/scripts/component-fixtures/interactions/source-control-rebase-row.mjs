// Drives the Source Control rebase row fixtures in headless Chromium with real clicks and keys:
// node config/scripts/component-fixtures/interactions/source-control-rebase-row.mjs [--out <dir>]
// Exits non-zero on the first failed check. Screenshots of each checked state go to --out.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../fixture-server-client.mjs'
import { fixtureCacheDir } from '../fixture-paths.mjs'

const outIndex = process.argv.indexOf('--out')
const outDir =
  outIndex > 0
    ? path.resolve(process.argv[outIndex + 1])
    : path.join(fixtureCacheDir, 'interactions')
const FIXTURE = 'right-sidebar/source-control/panel/rebase-row-interaction'

async function launch() {
  for (const options of [
    ...(process.env.ORCA_FIXTURES_BROWSER
      ? [{ executablePath: process.env.ORCA_FIXTURES_BROWSER }]
      : []),
    {},
    { channel: 'chrome' }
  ]) {
    try {
      return await chromium.launch({ headless: true, ...options })
    } catch {
      // Try the next browser.
    }
  }
  throw new Error('No headless Chromium found; see docs/agents-md-refs/component-fixtures.md')
}

const { url } = await ensureFixtureServer()
await mkdir(outDir, { recursive: true })
const browser = await launch()
const results = []

async function openFixture(name, width = 420) {
  const page = await browser.newPage({ viewport: { width, height: 400 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(
    `${url}/fixtures.html?id=${encodeURIComponent(`${FIXTURE}:${name}`)}&theme=dark`,
    {
      waitUntil: 'domcontentloaded',
      timeout: 180_000
    }
  )
  await page.waitForFunction(
    () => ['ready', 'error'].includes(document.documentElement.dataset.fixtureState ?? ''),
    undefined,
    { timeout: 180_000 }
  )
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.fixtureState),
    'ready',
    await page.evaluate(() => document.documentElement.dataset.fixtureError ?? '')
  )
  return { page, errors }
}

const focusedName = (page) =>
  page.evaluate(() => {
    const el = document.activeElement
    return el?.getAttribute('aria-label') || el?.textContent?.trim() || el?.tagName
  })
const describedBy = (locator) =>
  locator.evaluate((el) => {
    const id = el.getAttribute('aria-describedby')
    return (id && document.getElementById(id)?.textContent) || ''
  })
const status = (page) => page.getByRole('status')

async function check(name, run) {
  const started = performance.now()
  try {
    await run()
    results.push(`PASS ${name} (${Math.round(performance.now() - started)} ms)`)
  } catch (error) {
    results.push(
      `FAIL ${name}\n  ${String(error?.message ?? error)
        .split('\n')
        .join('\n  ')}`
    )
    process.exitCode = 1
  }
}

await check('Rebase, conflicts, keyboard Continue to done', async () => {
  const { page, errors } = await openFixture('behind')
  const rebase = page.getByRole('button', { name: 'Rebase onto origin/main' })
  await rebase.hover()
  await rebase.click()
  await page.waitForSelector('[aria-busy="true"]')
  await page.screenshot({ path: path.join(outDir, '1-rebasing.png') })
  await status(page).filter({ hasText: '2 conflicts' }).waitFor()

  const step = page.getByRole('button', { name: 'Continue' })
  assert.equal(await step.getAttribute('aria-disabled'), 'true')
  assert.equal(await describedBy(step), 'Resolve conflicts first')
  // Hover shows the reason tooltip on the unavailable button itself.
  await step.hover()
  await page.getByRole('tooltip').filter({ hasText: 'Resolve conflicts first' }).waitFor()
  await page.screenshot({ path: path.join(outDir, '2-paused-reason.png') })

  // Tab order: Abort rebase, then Continue.
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Abort rebase' }).focus()
  await page.keyboard.press('Tab')
  assert.equal(await focusedName(page), 'Continue')
  // Resolve both conflicts while Continue holds focus: it turns available in place.
  await page.evaluate(() => {
    window.__fakeRebaseRepo.resolveOneConflict()
    window.__fakeRebaseRepo.resolveOneConflict()
  })
  await page.waitForFunction(() => !document.querySelector('[aria-disabled="true"]'))
  assert.equal(await focusedName(page), 'Continue')
  await page.screenshot({ path: path.join(outDir, '3-continue-ready-focused.png') })

  await page.keyboard.press('Enter')
  await status(page).filter({ hasText: '1 conflict' }).waitFor()
  assert.equal(await focusedName(page), 'Continue', 'focus survives the step')
  await page.evaluate(() => window.__fakeRebaseRepo.resolveOneConflict())
  await page.waitForFunction(() => !document.querySelector('[aria-disabled="true"]'))
  await page.keyboard.press('Space')
  await page.getByText('Up to date').waitFor()
  await page.screenshot({ path: path.join(outDir, '4-done.png') })
  assert.deepEqual(errors, [])
  await page.close()
})

await check('Inspect failure shows why; Retry reads again; Continue runs', async () => {
  const { page, errors } = await openFixture('inspectFailed')
  const retry = page.getByRole('button', { name: 'Retry checking the rebase step' })
  await retry.waitFor()
  assert.match(await status(page).innerText(), /Couldn't check step/)
  assert.equal(
    await describedBy(retry),
    "Couldn't check this rebase step: WSL distro Ubuntu is not running"
  )
  await retry.hover()
  await page.getByRole('tooltip').filter({ hasText: 'WSL distro' }).waitFor()
  await page.screenshot({ path: path.join(outDir, '5-inspect-failed.png') })
  await page.mouse.move(0, 0)
  await retry.focus()
  await page.keyboard.press('Enter')
  await page
    .getByRole('button', { name: 'Continue' })
    .and(page.locator(':not([aria-disabled])'))
    .waitFor()
  assert.equal(await focusedName(page), 'Continue', 'focus survives Retry')
  await page.getByRole('button', { name: 'Continue' }).click()
  await status(page).filter({ hasText: '1 conflict' }).waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})

await check('Empty step offers Skip, which moves on', async () => {
  const { page, errors } = await openFixture('emptyStep')
  await page
    .getByRole('button', { name: 'Continue' })
    .and(page.locator(':not([aria-disabled])'))
    .click()
  const skip = page.getByRole('button', { name: 'Skip this rebase step' })
  await skip.waitFor()
  assert.match(await status(page).innerText(), /Empty step/)
  await page.screenshot({ path: path.join(outDir, '6-empty-step.png') })
  await skip.click()
  await status(page).filter({ hasText: '1 conflict' }).waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})

await check('Abort asks first; Cancel keeps the rebase; confirm aborts', async () => {
  const { page, errors } = await openFixture('pausedNarrow', 260)
  await page.screenshot({ path: path.join(outDir, '7-paused-narrow.png') })
  const abort = page.getByRole('button', { name: 'Abort rebase' })
  await abort.click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await page.screenshot({ path: path.join(outDir, '8-abort-confirm.png') })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  assert.match(await status(page).innerText(), /2 conflicts/)
  await abort.click()
  await dialog.getByRole('button', { name: 'Abort rebase' }).click()
  await page.getByRole('button', { name: 'Rebase onto origin/main' }).waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})

await browser.close()
console.log(results.join('\n'))
console.log(`Screenshots: ${outDir}`)
