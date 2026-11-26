// Drives the waiting ask of each stored ask in bots/items/BotItemRecommendedAsk in Chromium: the
// quick replies of one question and the stepped card of several. Checks what each choice shows and
// is named (from the browser's accessibility tree), how many carry the recommendation, and the exact
// comment a click or key posts. Writes every reading to <out>/results.json.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { fixtureServerCodeStamp, serverStatePath } from '../../component-fixtures/fixture-paths.mjs'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(
  outIndex === -1 ? '.cache/bot-item-recommended-ask' : process.argv[outIndex + 1]
)
const server = await ensureFixtureServer()
const { url } = server
// Which tree and server this run read, so its results name their source.
const provenance = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
  // A reused server is one this tree's code stamp matched; `started` says it was started for this run.
  server: {
    url,
    started: server.started,
    pid: JSON.parse(readFileSync(serverStatePath, 'utf8')).pid ?? null,
    codeStamp: fixtureServerCodeStamp()
  },
  startedAt: new Date().toISOString()
}
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
// A loaded machine can take minutes for a cold page; CHECK_TIMEOUT_MS raises the wait.
const timeout = Number(process.env.CHECK_TIMEOUT_MS ?? 60_000)
let page = null
let cdp = null
const results = []

/** Each fixture in a tab of its own: one tab reloaded many times can run out of memory on a loaded
 *  machine. */
async function open(name) {
  await page?.close()
  page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.setDefaultTimeout(timeout)
  cdp = await page.context().newCDPSession(page)
  await page.goto(`${url}/fixtures.html?id=bots/items/BotItemRecommendedAsk:${name}&theme=light`)
  await page.waitForFunction(() => document.documentElement.dataset.fixtureState === 'ready')
}

/** Each answer choice as the browser exposes it: accessible name, and the words it shows. */
async function choices() {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree')
  const names = nodes
    .filter((node) => node.role?.value === 'button' && !node.ignored)
    .map((node) => node.name?.value ?? '')
  const shown = await page.locator('#component-fixture-frame button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const copy = button.cloneNode(true)
      copy.querySelectorAll('.sr-only, [aria-hidden="true"]').forEach((node) => node.remove())
      // As painted, line breaks and all: hidden parts measure no text.
      const hidden = [...button.querySelectorAll('.sr-only, [aria-hidden="true"]')]
      hidden.forEach((node) => node.setAttribute('data-check-hidden', node.style.display))
      hidden.forEach((node) => (node.style.display = 'none'))
      const rendered = button.innerText.trim()
      hidden.forEach((node) => (node.style.display = node.getAttribute('data-check-hidden') ?? ''))
      hidden.forEach((node) => node.removeAttribute('data-check-hidden'))
      return {
        rendered,
        words: copy.textContent.trim(),
        star: (button.textContent.match(/★/g) ?? []).length
      }
    })
  )
  const visible = await page
    .locator('#component-fixture-frame')
    .evaluate((frame) => frame.innerText)
  return { names, shown, visible }
}

const posted = () =>
  page
    .locator('[data-sent] li')
    .evaluateAll((items) => items.map((item) => JSON.parse(item.textContent)))
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The choice whose words are exactly `label` (its star and screen-reader suffix aside). */
const chip = (label) =>
  page
    .locator('#component-fixture-frame button')
    .filter({ hasText: new RegExp(`^★?${escape(label)}(, Recommended)?$`) })
    .first()

async function quickReplies(name, { labels, recommended, click, tabFrom, key, marksStay }) {
  await open(name)
  const read = await choices()
  for (const label of labels) {
    const named = new RegExp(
      `^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${label === recommended ? ' ?, Recommended' : ''}$`
    )
    assert.ok(
      read.names.some((at) => named.test(at)),
      `${name}: "${label}" is named ${named}; got ${JSON.stringify(read.names)}`
    )
    assert.ok(
      read.shown.some((at) => at.words === label),
      `${name}: "${label}" shows as itself`
    )
  }
  const stars = read.shown.reduce((sum, at) => sum + at.star, 0)
  assert.equal(stars, recommended ? 1 : 0, `${name}: stars`)
  assert.equal(
    read.shown.find((at) => at.star)?.words ?? null,
    recommended ?? null,
    `${name}: the star is on the recommended choice`
  )
  if (recommended && !marksStay) {
    assert.doesNotMatch(
      read.visible,
      /\(\s*recommended\s*\)|\[\s*recommended\s*\]/i,
      `${name}: no written mark`
    )
  }
  // The keyboard path: Tab from one choice to the next, Enter posts it.
  await chip(tabFrom).focus()
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '')
  await page.keyboard.press('Enter')
  const byKey = await posted()
  assert.deepEqual(
    byKey,
    [{ text: key, questionId: 'e2' }],
    `${name}: Tab then Enter posts "${key}" (focused ${JSON.stringify(focused)})`
  )
  // A sent reply folds the line, so the click is read on a fresh ask.
  await open(name)
  await chip(click).click()
  const byClick = await posted()
  assert.deepEqual(byClick, [{ text: click, questionId: 'e2' }], `${name}: click posts the label`)
  results.push({ name, ...read, stars, focused, posted: { byKey, byClick } })
}

try {
  await quickReplies('written', {
    labels: ['Waive; ship it disclosed', 'Fix it first'],
    recommended: 'Waive; ship it disclosed',
    click: 'Waive; ship it disclosed',
    tabFrom: 'Waive; ship it disclosed',
    key: 'Fix it first'
  })
  await quickReplies('flagged', {
    labels: ['Merge now', 'Wait for Monday'],
    recommended: 'Wait for Monday',
    click: 'Wait for Monday',
    tabFrom: 'Merge now',
    key: 'Wait for Monday'
  })
  await quickReplies('twin', {
    labels: ['Go', 'Go (Recommended)'],
    recommended: undefined,
    click: 'Go (Recommended)',
    tabFrom: 'Go',
    key: 'Go (Recommended)'
  })
  await quickReplies('joined', {
    labels: ['Audit', 'Notify', 'Audit, Notify (Recommended)'],
    recommended: undefined,
    click: 'Audit, Notify (Recommended)',
    tabFrom: 'Audit',
    key: 'Notify'
  })

  // Labels kept as written, a mark and all: the star is only the flag's.
  await quickReplies('delimited', {
    labels: ['Audit, (Recommended)', 'Audit,', 'Audit [recommended]', '(Recommended)'],
    recommended: 'Audit [recommended]',
    click: 'Audit [recommended]',
    tabFrom: 'Audit, (Recommended)',
    key: 'Audit,',
    marksStay: true
  })
  await quickReplies('attached', {
    labels: ['Wait', 'Go(Recommended) [recommended]'],
    recommended: 'Wait',
    click: 'Go(Recommended) [recommended]',
    tabFrom: 'Wait',
    key: 'Go(Recommended) [recommended]',
    marksStay: true
  })
  await quickReplies('twinFlagged', {
    labels: ['Go', 'Go (Recommended)'],
    recommended: 'Go',
    click: 'Go (Recommended)',
    tabFrom: 'Go',
    key: 'Go (Recommended)',
    marksStay: true
  })

  await quickReplies('bracketAttached', {
    labels: ['Go', 'Go(Recommended)'],
    recommended: 'Go',
    click: 'Go(Recommended)',
    tabFrom: 'Go',
    key: 'Go(Recommended)',
    marksStay: true
  })
  await quickReplies('commaWait', {
    labels: ['A, (Recommended)', 'Wait'],
    recommended: 'Wait',
    click: 'A, (Recommended)',
    tabFrom: 'A, (Recommended)',
    key: 'Wait',
    marksStay: true
  })

  // Several questions: the stepped card, picked by click and by keyboard, then sent.
  await open('several')
  const read = await choices()
  const stars = read.shown.reduce((sum, at) => sum + at.star, 0)
  assert.equal(stars, 2, 'several: one star per question')
  for (const label of ['Ship it', 'No']) {
    assert.ok(
      read.names.some((at) => new RegExp(`^${label} ?, Recommended$`).test(at)),
      `several: "${label}" is named as recommended; got ${JSON.stringify(read.names)}`
    )
  }
  assert.doesNotMatch(read.visible, /\(\s*recommended\s*\)|\[\s*recommended\s*\]/i)
  await chip('Ship it').click()
  // Picking moves focus to the next open line's first choice; Tab to its recommended one.
  const next = await page.evaluate(() => document.activeElement?.textContent ?? '')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  // The last pick moves focus to Send.
  const send = await page.evaluate(() => document.activeElement?.textContent ?? '')
  await page.keyboard.press('Enter')
  const sent = await posted()
  assert.deepEqual(
    sent.map((entry) => entry.text),
    ['Ship the sidebar? → Ship it\nKeep the old layout? → No'],
    `several: Send posts both picks (focus after first pick ${JSON.stringify(next)}, then ${JSON.stringify(send)})`
  )
  assert.equal(sent[0].questionId, 'e2')
  results.push({ name: 'several', ...read, stars, focus: { next, send }, posted: sent })

  // A label of several lines stays as written, so the stepped answer is told from it.
  await open('multiline')
  const lines = await choices()
  // Painted on two lines, not only kept in the text.
  assert.ok(
    lines.shown.some((at) => at.rendered === 'A\nSecond? → B (Recommended)'),
    `multiline: the label shows its two lines; got ${JSON.stringify(lines.shown)}`
  )
  await chip('A').click()
  await chip('B').click()
  const multilineSend = await page.evaluate(() => document.activeElement?.textContent ?? '')
  await page.keyboard.press('Enter')
  const multilineSent = await posted()
  assert.deepEqual(
    multilineSent.map((entry) => entry.text),
    ['First? → A\nSecond? → B'],
    `multiline: Send posts both lines (focus ${JSON.stringify(multilineSend)})`
  )
  results.push({ name: 'multiline', ...lines, posted: multilineSent })

  await writeFile(
    path.join(out, 'results.json'),
    JSON.stringify({ ...provenance, browser: browser.version(), results }, null, 2)
  )
  console.log(`PASS: ${results.length} waiting asks checked in Chromium ${browser.version()}`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
  await writeFile(
    path.join(out, 'results.json'),
    JSON.stringify({ ...provenance, failed: String(error), results }, null, 2)
  )
  await page?.screenshot({ path: path.join(out, 'failure.png'), timeout: 10_000 }).catch(() => {})
} finally {
  await browser.close()
}
