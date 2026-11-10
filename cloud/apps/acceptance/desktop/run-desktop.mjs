#!/usr/bin/env node
// Desktop (Electron) acceptance run for Orca Cloud: launches the dev Orca built from this checkout
// against the DEV cloud backends, drives the real UI over CDP (playwright-core), and writes
// results.json + screenshots into the artifacts dir given as argv[2].
//
//   node cloud/apps/acceptance/desktop/run-desktop.mjs <artifactsDir>
//
// Starts signed out on a fresh profile (dev auth) and signs in from the Orca Cloud sign-in card, so
// the #127 fixes are covered: D-1/D-4 auth.signed-out-create, D-3 proj.cloud-name, D-2
// life.delete-unconfirmed (+ life.delete-after-oob-destroy, life.destroy for a normal delete).
// Env: ORCA_CLOUD_SANDBOX_URL / ORCA_CLOUD_SANDBOX_DEV_KEY_FILE / ORCA_BILLING_API_URL override the
// dev defaults; W9D_USER (default w9-desktop) is the dev account; W9D_WAKE_CYCLES (default 5);
// W9D_SKIP_BUILD=1 skips the workspace-package/native/CLI prebuild.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream, readdirSync, rmdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { DEV_KEY_FILE, SANDBOX_URL, deleteAllSandboxes, listSandboxes, sandboxApi, sandboxApiOrg } from './sandbox-api.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const artifactsDir = path.resolve(process.argv[2] ?? `/tmp/orca-desktop-acceptance-${Date.now()}`)
const shotsDir = path.join(artifactsDir, 'screenshots')
mkdirSync(shotsDir, { recursive: true })

const USER = process.env.W9D_USER ?? 'w9-desktop'
const REPO_SLUG = 'nwparker/orca-sandbox-push-test'
const WAKE_CYCLES = Number(process.env.W9D_WAKE_CYCLES ?? 5)
const KEY_SAMPLES = 10
const HTTP_SAMPLES = 10
const PORT = 4173
const runTag = new Date().toISOString().replace(/[:.]/g, '-')
const wsName = `w9d-${Date.now().toString(36)}`
const HEAVY = '/tmp/vdrv/heavy.sh'

const results = {
  runTag,
  startedAt: new Date().toISOString(),
  repoRoot,
  gitHead: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  sandboxUrl: SANDBOX_URL,
  account: `dev:${USER}`,
  workspaceName: wsName,
  notes: [],
  app: {},
  steps: [],
  bugs: [],
  cleanup: {}
}
const created = { sandboxIds: new Set(), localPaths: [], foreign: [] }
let runner = null
let browser = null
let page = null
let ctx = null

function git(...args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
function log(...a) {
  console.error(`[desktop ${new Date().toISOString().slice(11, 19)}]`, ...a)
}
function save() {
  results.updatedAt = new Date().toISOString()
  writeFileSync(path.join(artifactsDir, 'results.json'), JSON.stringify(results, null, 2))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function pct(samples, p) {
  const s = [...samples].sort((a, b) => a - b)
  if (!s.length) return null
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}
function stats(samples) {
  return samples.length
    ? { n: samples.length, p50: pct(samples, 50), p95: pct(samples, 95), min: Math.min(...samples), max: Math.max(...samples), samples }
    : { n: 0 }
}
const redact = (s) => String(s ?? '').replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>')

async function shot(step, name) {
  const file = path.join(shotsDir, `${step.id.replace(/[^a-z0-9.-]/gi, '_')}-${name}.png`)
  try {
    await page.screenshot({ path: file })
    step.screenshots.push(path.relative(artifactsDir, file))
  } catch (e) {
    step.screenshots.push(`(screenshot failed: ${e.message})`)
  }
  return file
}

async function runStep(id, title, fn) {
  const step = { id, title, status: 'fail', detail: '', screenshots: [], timings: {}, startedAt: new Date().toISOString() }
  results.steps.push(step)
  log('step', id, title)
  const t0 = Date.now()
  try {
    await fn(step)
  } catch (e) {
    step.status = 'fail'
    step.detail = `${step.detail ? step.detail + ' | ' : ''}error: ${redact(e.message).slice(0, 600)}`
    await shot(step, 'error')
  }
  step.durationMs = Date.now() - t0
  log('  ->', step.status, step.detail.slice(0, 200))
  save()
  return step
}
function bug(step, { title, expected, actual, repro, screenshot }) {
  results.bugs.push({ step, title, expected, actual, repro, screenshot })
  save()
}

// ---------- app lifecycle ----------

function prebuild() {
  if (process.env.W9D_SKIP_BUILD === '1') return
  const cmd = [
    `cd ${JSON.stringify(repoRoot)}`,
    'node config/scripts/workspace-package-build/build-workspace-packages.mjs',
    'node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=electron',
    // `orca ssh` / Copy SSH Command tunnel through the dev CLI; `pnpm dev` does not build it.
    ...(existsSync(path.join(repoRoot, 'out/cli/index.js')) ? [] : ['node config/scripts/cli-build/build-cli.mjs'])
  ].join(' && ')
  log('prebuild (heavy lock)')
  const t0 = Date.now()
  const r = existsSync(HEAVY)
    ? spawnSync(HEAVY, [cmd], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    : spawnSync('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  writeFileSync(path.join(artifactsDir, 'prebuild.log'), `${r.stdout}\n${r.stderr}`)
  results.app.prebuildMs = Date.now() - t0
  if (r.status !== 0) throw new Error(`prebuild failed (${r.status}); see prebuild.log`)
}

const appEnv = (userData) => ({
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: '1',
  ORCA_DEV_USER_DATA_PATH: userData,
  ORCA_CLOUD_SANDBOX_URL: SANDBOX_URL,
  ORCA_CLOUD_SANDBOX_DEV_KEY_FILE: DEV_KEY_FILE,
  ORCA_BILLING_API_URL: process.env.ORCA_BILLING_API_URL ?? 'https://orca-billing-dev.lovecast.workers.dev',
  ORCA_CLOUD_DEV_AUTH: '1',
  ORCA_CLOUD_DEV_USER_ID: USER
})

async function launchApp(userData, label) {
  const logFile = path.join(artifactsDir, `app-${label}.log`)
  const out = createWriteStream(logFile)
  const t0 = Date.now()
  // Mock keychain: a fresh dev app identity otherwise blocks Electron's main thread on a macOS
  // Keychain prompt (safeStorage) that nobody can answer on an unattended or locked test Mac.
  const child = spawn(process.execPath, ['config/scripts/development/launch/run-electron-vite-dev.mjs', '--', '--use-mock-keychain', '--password-store=basic'], {
    cwd: repoRoot,
    env: appEnv(userData),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  runner = child
  let buf = ''
  const instance = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ORCA_DEV_INSTANCE line within 180s')), 180_000)
    const onData = (d) => {
      out.write(d)
      buf += d.toString()
      const m = buf.match(/^ORCA_DEV_INSTANCE (\{.*\})$/m)
      if (m) {
        clearTimeout(timer)
        resolve(JSON.parse(m[1]))
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => reject(new Error(`dev runner exited early (${code}); see ${logFile}`)))
  })
  child.stdout.removeAllListeners('data')
  child.stderr.removeAllListeners('data')
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  log('instance', instance.cdpUrl, instance.rendererUrl, 'runner pid', child.pid)
  const deadline = Date.now() + 300_000
  let seen = null
  for (;;) {
    try {
      const targets = await (await fetch(`${instance.cdpUrl}/json`)).json()
      seen = targets.map((t) => `${t.type} ${t.url.slice(0, 80)}`)
      if (targets.some((t) => t.type === 'page' && t.url.startsWith(instance.rendererUrl))) break
    } catch (e) {
      seen = `cdp error: ${e.message}`
    }
    if (Date.now() > deadline) throw new Error(`renderer never appeared on CDP; targets ${JSON.stringify(seen)}`)
    await sleep(1000)
  }
  browser = await chromium.connectOverCDP(instance.cdpUrl)
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(instance.rendererUrl))
  if (!page) throw new Error('renderer page not found after connect')
  await page.waitForFunction(() => Boolean(window.__store?.getState?.().repos), null, { timeout: 120_000 })
  results.app[label] = { cdpUrl: instance.cdpUrl, rendererUrl: instance.rendererUrl, runnerPid: child.pid, launchMs: Date.now() - t0, log: path.relative(artifactsDir, logFile) }
  save()
  return instance
}

async function stopApp() {
  if (!runner?.pid) return
  const pid = runner.pid
  const cmd = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout
  if (!cmd.includes('run-electron-vite-dev.mjs')) {
    log('refusing to kill pid', pid, 'cmd:', cmd.trim())
    return
  }
  // Leave the CDP socket without closing the app's windows, then stop only our runner tree.
  browser = null
  runner.kill('SIGTERM')
  for (let i = 0; i < 30 && spawnSync('ps', ['-p', String(pid)]).status === 0; i++) await sleep(500)
  if (spawnSync('ps', ['-p', String(pid)]).status === 0) runner.kill('SIGKILL')
  runner = null
}

// ---------- UI helpers ----------

async function store(fn, arg) {
  // A first launch can reload the renderer under us; retry once the new document has the store.
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(fn, arg)
    } catch (e) {
      if (attempt >= 4 || !/garbage collected|Execution context was destroyed|navigation/i.test(e.message)) throw e
      log('  store() retry after', e.message.slice(0, 80))
      await sleep(2000)
      await page.waitForFunction(() => Boolean(window.__store?.getState?.().repos), null, { timeout: 60_000 }).catch(() => {})
    }
  }
}

async function installToastRecorder() {
  await page.evaluate(() => {
    window.__w9dToasts = []
    if (window.__w9dToastObs) return
    window.__w9dToastObs = new MutationObserver(() => {
      document.querySelectorAll('[data-sonner-toast]').forEach((t) => {
        const s = t.innerText
        if (s && !window.__w9dToasts.includes(s)) window.__w9dToasts.push(s)
      })
    })
    window.__w9dToastObs.observe(document.body, { subtree: true, childList: true, characterData: true })
  })
}
const toasts = () => page.evaluate(() => window.__w9dToasts ?? [])
const clearToasts = () => page.evaluate(() => { window.__w9dToasts = [] })

/**
 * The row titled `name` that runs on `kind` ('cloud' = Orca Cloud badge, 'local' = Local Mac). Move to
 * this computer makes a local copy with the same name, so the title alone is ambiguous.
 */
async function rowOf(name, kind = 'cloud') {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const all = page.locator('[data-worktree-title-inline-rename]', { hasText: new RegExp(`^${esc}$`) })
  const n = await all.count().catch(() => 0)
  for (let i = 0; i < n; i++) {
    const k = await all.nth(i).evaluate((el) => {
      for (let e = el, j = 0; e && j < 8; e = e.parentElement, j++) {
        const t = e.innerText || ''
        if (/Orca Cloud/.test(t)) return 'cloud'
        if (/Local Mac/.test(t)) return 'local'
      }
      return null
    }).catch(() => null)
    if (k === kind) return all.nth(i)
  }
  return null
}
async function rowShown(name, kind = 'cloud') {
  const r = await rowOf(name, kind)
  return r ? r.isVisible().catch(() => false) : false
}
async function waitRowGone(name, kind, timeoutMs) {
  const t0 = Date.now()
  while (await rowShown(name, kind)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`${kind} row "${name}" still shown after ${timeoutMs}ms`)
    await sleep(250)
  }
}
async function openRowMenu(name, kind = 'cloud') {
  await page.keyboard.press('Escape').catch(() => {})
  const r = await rowOf(name, kind)
  if (!r) throw new Error(`no ${kind} row "${name}"`)
  await r.click({ button: 'right' })
  await page.getByRole('menuitem').first().waitFor({ timeout: 5000 })
  await sleep(250)
}
const menuItems = () => page.getByRole('menuitem').allInnerTexts()

async function dismissNoise() {
  for (const name of ['No thanks', 'Later']) {
    await page.getByRole('button', { name, exact: true }).first().click({ timeout: 500 }).catch(() => {})
  }
}

async function visibleTerminals() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows')]
      .filter((r) => r.getBoundingClientRect().width > 0)
      .map((r) => r.innerText.replace(/ /g, ' ').trimEnd())
  )
}
async function focusTerminal() {
  await page.locator('.xterm-screen').filter({ visible: true }).last().click()
}
const lastLine = (t) => t.split('\n').filter((l) => l.trim()).pop() ?? ''
const isShellPrompt = (t) => /\$\s*$/.test(lastLine(t))

async function openNewTerminalTab() {
  await page.locator('button[aria-label="New tab"]:visible').first().click()
  await page.getByRole('menuitem', { name: /New Terminal/ }).click()
}

/** Keydown (capture listener, in-page clock) -> the char shows up in the visible xterm DOM. */
async function measureKeystroke(marker) {
  await page.keyboard.type(marker.slice(0, -1))
  await sleep(350)
  await page.evaluate((marker) => {
    const rows = [...document.querySelectorAll('.xterm-rows')].filter((r) => r.getBoundingClientRect().width > 0).pop()
    window.__w9dLat = { down: 0, echo: 0 }
    window.addEventListener('keydown', () => { if (!window.__w9dLat.down) window.__w9dLat.down = performance.now() }, { capture: true, once: true })
    const obs = new MutationObserver(() => {
      if (!window.__w9dLat.echo && rows.innerText.includes(marker)) {
        window.__w9dLat.echo = performance.now()
        obs.disconnect()
      }
    })
    obs.observe(rows, { subtree: true, childList: true, characterData: true })
  }, marker)
  await page.keyboard.press(marker.slice(-1))
  await page.waitForFunction(() => window.__w9dLat.echo > 0, null, { timeout: 15_000 })
  const l = await page.evaluate(() => window.__w9dLat)
  await page.keyboard.press('Control+U')
  await sleep(250)
  return Math.round(l.echo - l.down)
}

/** The sandbox this run created: listed under the dev account, created after Create was clicked. */
async function sandboxForWorkspace(since) {
  const { items } = await listSandboxes(USER)
  const mine = items.filter((s) => (s.createdAt ?? 0) >= since - 5000)
  return { items, newest: mine.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null }
}
async function sandboxStatus(id) {
  const r = await sandboxApi(USER, 'GET', `/v1/sandboxes/${id}`)
  return { http: r.status, status: r.json?.sandbox?.status ?? r.json?.error ?? null }
}
async function waitSandboxStatus(id, want, timeoutMs) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await sandboxStatus(id)
    if (want.includes(last.status)) return { ...last, ms: Date.now() - t0 }
    await sleep(1000)
  }
  return { ...last, ms: Date.now() - t0, timedOut: true }
}

const authState = () =>
  store(() => {
    const s = window.__store.getState()
    const active = s.orcaProfiles?.find((p) => p.id === s.activeOrcaProfileId)
    return { state: s.orcaProfileAuthStatus?.state ?? null, userId: active?.cloud?.userId ?? null, orgId: active?.cloud?.activeOrgId ?? null }
  })

/** Live (not destroyed) sandbox ids per dev account. */
async function sandboxIdsFor(users) {
  const out = {}
  for (const u of users) {
    out[u] = (await listSandboxes(u)).items.filter((s) => !/^(destroyed|deleted)$/.test(String(s.status ?? s.state))).map((s) => s.id)
  }
  return out
}

async function openComposer(step, shotName) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.getByRole('button', { name: 'New workspace', exact: true }).first().click()
  const d = page.getByRole('dialog')
  await d.waitFor()
  await d.getByRole('combobox', { name: 'Project' }).click()
  await page.getByRole('option', { name: /orca-sandbox-push-test/ }).first().click()
  d.shotName = shotName
  return d
}
async function pickOrcaCloud(step, d) {
  await d.getByRole('combobox', { name: 'Run on' }).click()
  const targets = page.getByRole('listbox', { name: 'Run targets' })
  await targets.waitFor()
  step.runTargets ??= (await targets.getByRole('option').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  if (d.shotName) {
    await shot(step, d.shotName)
    d.shotName = null
  }
  const opt = targets.getByRole('option', { name: /Orca Cloud/ }).first()
  const text = (await opt.innerText()).replace(/\s+/g, ' ').trim()
  await opt.click()
  return text
}
// The Run on trigger is labelled "Run on"; its visible value sits next to the field label.
const runOnValue = (d) =>
  d.getByRole('combobox', { name: 'Run on' }).evaluate((e) => {
    for (let n = e, j = 0; n && j < 4; n = n.parentElement, j++) {
      const t = (n.innerText || '').replace(/\s+/g, ' ').trim()
      const v = t.replace(/^Run on\s*/, '')
      if (v && v !== t) return v
    }
    return (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim()
  }).catch(() => null)
async function fillName(d, name) {
  // Smart mode offers "Use … as workspace name"; the Name tab takes the text as is.
  await d.getByPlaceholder(/Type a name|Workspace name/).fill(name)
  await page.getByRole('option', { name: /as workspace name/ }).click({ timeout: 2000 }).catch(() => {})
}

/** Click Create already happened at t0: follow the build sheet until a terminal prints. */
async function waitForWorkspaceReady(step, t0, { onTick } = {}) {
  let provisioningShot = false
  const phases = []
  for (;;) {
    const s = await page.evaluate(() => {
      const body = document.body.innerText
      const rows = [...document.querySelectorAll('.xterm-rows')].filter((r) => r.getBoundingClientRect().width > 0)
      return {
        starting: /Starting your cloud workspace/.test(body),
        failed: /Couldn.t start your cloud workspace/.test(body),
        text: (body.match(/Starting your cloud workspace[\s\S]{0,400}/)?.[0] ?? '').replace(/\s+/g, ' '),
        xterm: rows.map((r) => r.innerText.trim().length)
      }
    })
    if (onTick) await onTick()
    const t = Date.now() - t0
    const phase = s.text.match(/(Start sandbox|Prepare environment|Open workspace) In progress/)?.[1] ?? null
    if (phase && phases.at(-1)?.phase !== phase) phases.push({ phase, t })
    if (s.starting && !provisioningShot && t > 1500) {
      await shot(step, 'provisioning')
      provisioningShot = true
    }
    if (s.failed) {
      step.detail = `create failed: ${redact((await page.locator('main').innerText().catch(() => '')).slice(0, 400))}`
      throw new Error(step.detail)
    }
    if (!s.starting && s.xterm.some((n) => n > 0)) return { firstOutput: t, phases }
    if (t > 300_000) throw new Error('workspace not ready in 300s')
    await sleep(100)
  }
}

/** Click the Force Delete offer wherever the app shows it (toast action or the delete dialog). */
async function clickForceDelete(step, name) {
  const visible = page.getByRole('button', { name: /^Force Delete$/i }).filter({ visible: true })
  if ((await visible.count()) === 0) {
    // Not offered in place: reopen Delete and look in the dialog.
    await page.keyboard.press('Escape').catch(() => {})
    await openRowMenu(name)
    await page.getByRole('menuitem', { name: /^Delete/ }).click()
    await sleep(800)
    step.forceSurface = 'dialog (reopened)'
  } else {
    step.forceSurface = (await page.getByRole('dialog').filter({ visible: true }).count()) ? 'dialog' : 'toast'
  }
  await shot(step, 'force-offer')
  await page.getByRole('button', { name: /^Force Delete$/i }).filter({ visible: true }).first().click({ timeout: 10_000 })
  await sleep(600)
  // A confirm for the force action, if any.
  await page.getByRole('dialog').getByRole('button', { name: /^(Force Delete|Delete( Workspace)?)$/i }).first().click({ timeout: 2000 }).catch(() => {})
}

/** Asleep delete (#149): no wake, refusal offering Force delete, Force delete destroys the VM. */
async function asleepDeleteCheck(step, name, id) {
  step.sandboxId = id
  step.before = await sandboxStatus(id)
  const o = await uiDelete(step, name, 'asleep', 30_000)
  step.firstDelete = o
  const refused = o.kind === 'error' && /asleep/i.test(o.text ?? '') && /Force delete/i.test(o.text ?? '')
  // No wake: the control plane never sees a resume.
  const states = []
  for (let i = 0; i < 6; i++) {
    states.push((await sandboxStatus(id)).status)
    await sleep(500)
  }
  step.statesAfterRefusal = states
  const woke = states.some((x) => /running|resum|starting/.test(String(x)))
  const t0 = Date.now()
  let forced = null
  if (o.kind !== 'removed') {
    await clearToasts()
    await clickForceDelete(step, name)
    let gone = false
    while (Date.now() - t0 < 120_000) {
      if (!(await rowShown(name))) { gone = true; break }
      await sleep(250)
    }
    forced = { rowGone: gone, ms: Date.now() - t0, toasts: (await toasts()).map(redact) }
    await shot(step, 'after-force')
  }
  step.forceDelete = forced
  const w = await waitSandboxStatus(id, ['destroyed'], 120_000)
  step.timings.forceToRowGoneMs = forced?.ms ?? null
  step.timings.forceToDestroyedMs = forced ? Date.now() - t0 : null
  step.finalSandboxStatus = w.status
  const direct = o.kind === 'removed' && !o.rowVisibleAfter
  // Delete Workspace in the dialog went through without any Force delete offer: the VM still must not
  // wake and must be destroyed, but the #149 "offers Force delete" half is not what the UI does.
  step.status = refused && !woke && forced?.rowGone && !w.timedOut ? 'pass' : direct && !woke && !w.timedOut ? 'partial' : 'fail'
  step.detail = `before: ${step.before.status}; Delete -> ${o.kind}${o.text ? ` "${o.text}"` : ''}${direct ? ' (dialog "Delete Workspace" deleted it directly; no refusal, no Force delete offer)' : ''}; control plane right after: ${JSON.stringify(states)} (woke: ${woke}); ${forced ? `Force delete via ${step.forceSurface} -> row gone ${forced.rowGone} in ${forced.ms}ms; ` : ''}sandbox ${id} -> ${w.status}${w.timedOut ? ' (timed out)' : ''}; toasts during delete ${JSON.stringify(o.toasts)}`
  if (step.status === 'partial') {
    bug(step.id, {
      title: 'Asleep Orca Cloud Delete from the dialog deletes directly (no wake, destroyed) without the "Use Force delete" refusal #149 describes',
      expected: 'without force: refusal offering Force delete; Force delete destroys',
      actual: step.detail,
      repro: step.id === 'life.delete-asleep-after-move' ? 'Orca Cloud workspace -> Move to this computer -> Delete -> Delete Workspace' : 'Orca Cloud workspace -> Sleep -> Delete -> Delete Workspace',
      screenshot: step.screenshots.find((x) => x.includes('asleep-confirm'))
    })
  }
  if (step.status === 'fail') {
    bug(step.id, {
      title: 'Asleep Orca Cloud Delete does not follow the #149 flow (refuse without force, no wake, Force delete destroys)',
      expected: 'refusal offering Force delete, VM stays asleep, Force delete removes the row and destroys the sandbox',
      actual: step.detail,
      repro: step.id === 'life.delete-asleep-after-move' ? 'Orca Cloud workspace -> Move to this computer -> Delete the cloud row' : 'Orca Cloud workspace -> Sleep -> Delete',
      screenshot: step.screenshots.at(-1)
    })
  }
}

/** A plain signed-in Orca Cloud create for checks that consume a workspace. */
async function createExtraWorkspace(step, name) {
  const d = await openComposer(step, `${name}-composer`)
  for (let i = 0; i < 3; i++) {
    await pickOrcaCloud(step, d)
    await sleep(1200)
    if (/Orca Cloud/.test((await runOnValue(d)) ?? '')) break
  }
  await fillName(d, name)
  const t0 = Date.now()
  await d.getByRole('button', { name: /Create workspace/ }).click()
  await waitForWorkspaceReady(step, t0)
  await dismissNoise()
  const sb = await sandboxForWorkspace(t0)
  if (!sb.newest) throw new Error(`no sandbox listed for ${name}`)
  created.sandboxIds.add(sb.newest.id)
  step.createdForCheck = { name, sandboxId: sb.newest.id, createMs: Date.now() - t0 }
  return { name, sandboxId: sb.newest.id }
}

/** Open the cloud workspace and type until an echo comes back (wakes it if asleep). Returns ms. */
async function wakeWorkspace(name, marker = `echo w9wake${Date.now() % 1000}`) {
  const t0 = Date.now()
  await page.keyboard.press('Escape').catch(() => {})
  await (await rowOf(name)).click()
  let lastType = 0
  while (Date.now() - t0 < 180_000) {
    const terms = await visibleTerminals()
    if (terms.some((t) => t.includes(marker))) {
      await page.keyboard.press('Control+U')
      return Date.now() - t0
    }
    if (terms.length && Date.now() - lastType > 1500) {
      await focusTerminal().catch(() => {})
      await page.keyboard.press('Control+U')
      await page.keyboard.type(marker)
      lastType = Date.now()
    }
    await sleep(100)
  }
  throw new Error(`workspace ${name} did not answer within 180s`)
}

/** UI Delete on a workspace row; returns what the app showed. Does not throw on a kept row. */
async function uiDelete(step, name, label, timeoutMs = 90_000, watchAfterMs = 0) {
  await clearToasts()
  await openRowMenu(name)
  await page.getByRole('menuitem', { name: /^Delete/ }).click()
  const d = page.getByRole('dialog')
  const dialog = (await d.innerText()).replace(/\s+/g, ' ')
  await shot(step, `${label}-confirm`)
  const t0 = Date.now()
  await d.getByRole('button', { name: /^Delete( Workspace)?$/ }).click()
  let outcome = null
  while (Date.now() - t0 < timeoutMs) {
    const gone = !(await rowShown(name))
    const body = await page.evaluate(() => document.body.innerText)
    const err = [...(await toasts()), body].find((t) => /couldn.t confirm|could not confirm|Couldn.t delete|Failed to delete|is asleep/i.test(t))
    if (err) {
      outcome = { kind: 'error', text: redact(err.match(/[^\n]*(couldn.t confirm|could not confirm|Couldn.t delete|Failed to delete|is asleep)[\s\S]{0,300}/i)?.[0] ?? err.slice(0, 300)) }
      break
    }
    if (gone) {
      outcome = { kind: 'removed' }
      break
    }
    await sleep(250)
  }
  outcome ??= { kind: 'timeout' }
  outcome.ms = Date.now() - t0
  if (outcome.kind === 'removed' && watchAfterMs) {
    // Teardown can fail after the row is gone; look for the error wherever the app puts it.
    const t1 = Date.now()
    while (Date.now() - t1 < watchAfterMs) {
      const body = await page.evaluate(() => document.body.innerText)
      const err = [...(await toasts()), body].find((t) => /couldn.t confirm|could not confirm|Cleanup|Couldn.t delete|Failed to delete/i.test(t))
      if (err) {
        outcome.laterError = { afterMs: Date.now() - t0, text: redact(err.match(/[^\n]*(couldn.t confirm|could not confirm|Cleanup|Couldn.t delete|Failed to delete)[\s\S]{0,240}/i)?.[0] ?? err.slice(0, 300)) }
        break
      }
      await sleep(500)
    }
    await shot(step, `${label}-watch`)
  }
  await sleep(4000)
  outcome.rowVisibleAfter = await rowShown(name)
  outcome.toasts = (await toasts()).map(redact)
  outcome.dialog = dialog
  await shot(step, `${label}-after`)
  return outcome
}

// ---------- flow ----------

async function main() {
  save()
  if (!existsSync(DEV_KEY_FILE)) throw new Error(`dev key file missing: ${DEV_KEY_FILE}`)
  const before = await listSandboxes(USER)
  results.preexistingSandboxes = before.items.map((s) => ({ id: s.id, status: s.status ?? s.state }))
  prebuild()

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'orca-w9d-'))
  const userData = path.join(tmp, 'profile')
  const repoDir = path.join(tmp, 'repos', 'orca-sandbox-push-test')
  mkdirSync(userData, { recursive: true })
  results.app.userData = userData
  try {
    execFileSync('gh', ['repo', 'clone', REPO_SLUG, repoDir, '--', '--quiet'], { stdio: 'ignore' })
  } catch {
    // Hosts without access to the private test repo (e.g. a remote test Mac): a local repo with the
    // same origin URL is enough, because the cloud clone runs through the Orca GitHub App.
    mkdirSync(repoDir, { recursive: true })
    const g = (...args) => execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' })
    g('init', '-q', '-b', 'main')
    writeFileSync(path.join(repoDir, 'README.md'), '# orca-sandbox-push-test\n')
    g('add', 'README.md')
    g('-c', 'user.email=w9@orca.dev', '-c', 'user.name=W9', 'commit', '-qm', 'Initial commit')
    g('remote', 'add', 'origin', `https://github.com/${REPO_SLUG}.git`)
    results.notes.push('test repo not clonable here; used a local repo with the same origin URL')
  }
  created.tmp = tmp

  const setup = await runStep('setup', 'Launch dev Orca on a fresh profile (signed out), add repo', async (step) => {
    // #127 keys the sandbox token on the signed-in identity, so no sign-in-then-relaunch dance: the
    // app stays signed out here and signs in from the Orca Cloud sign-in card (auth.signed-out-create).
    await launchApp(userData, 'main')
    step.timings.launchMs = results.app.main.launchMs
    await store(() => window.__store.getState().updateSettings({ terminalGpuAcceleration: 'off' }))
    await store(async (p) => {
      await window.api.repos.add({ path: p })
      await window.__store.getState().fetchRepos({})
    }, repoDir)
    const repos = await store(() => window.__store.getState().repos.map((r) => r.displayName))
    const auth = await authState()
    step.authAtStart = auth
    await installToastRecorder()
    step.status = auth.state !== 'connected' && repos.includes('orca-sandbox-push-test') ? 'pass' : 'partial'
    step.detail = `auth at start ${JSON.stringify(auth)}; repos ${JSON.stringify(repos)}; terminal GPU off so xterm renders to DOM`
    await shot(step, 'home')
  })

  if (setup.status === 'fail' || !page) throw new Error(`setup failed: ${setup.detail}`)

  // ---- D-1 / D-4: Orca Cloud create while signed out -> sign-in card, nothing created; sign in -> proceeds.
  let signedOutWs = null
  let signedOutSandboxId = null
  await runStep('auth.signed-out-create', 'Signed out: Orca Cloud create shows the sign-in card and creates nothing; sign in from the card -> create proceeds as dev:<user> (D-1, D-4)', async (step) => {
    const name = `${wsName}-so`
    const watched = [USER, 'desktop-dogfood', 'dev-user']
    const baseline = await sandboxIdsFor(watched)
    const d = await openComposer(step, 'signed-out')
    const pickT0 = Date.now()
    const pickStartedAt = new Date().toISOString()
    const runOn = await pickOrcaCloud(step, d)
    // Dev auth signs in without a browser. #149: the pick should end with Orca Cloud selected.
    let pickToSelectedMs = null
    while (Date.now() - pickT0 < 15_000) {
      if (/Orca Cloud/.test((await runOnValue(d)) ?? '') && (await authState()).state === 'connected') {
        pickToSelectedMs = Date.now() - pickT0
        break
      }
      await sleep(250)
    }
    step.afterPick = { auth: await authState(), runOn: await runOnValue(d), dialogOpen: await d.isVisible().catch(() => false) }
    await shot(step, 'after-pick')
    let path_ = 'composer-create'
    // D-1 for the picker itself: picking Orca Cloud signed out must not create anything.
    const afterPickLists = await sandboxIdsFor(watched)
    step.createdByPick = Object.fromEntries(watched.map((u) => [u, afterPickLists[u].filter((id) => !baseline[u].includes(id))]))
    {
      const selected = step.afterPick.auth.state === 'connected' && /Orca Cloud/.test(step.afterPick.runOn ?? '')
      const none = Object.values(step.createdByPick).every((ids) => ids.length === 0)
      const pick = {
        id: 'auth.picker-sign-in',
        title: 'Signed out: picking the Orca Cloud row signs in and leaves Orca Cloud selected (#149)',
        status: selected && none ? 'pass' : 'fail',
        detail: `picker row "${runOn}"; after the pick: auth ${step.afterPick.auth.state} as ${step.afterPick.auth.userId}, Run on "${step.afterPick.runOn}" (${pickToSelectedMs === null ? 'not selected within 15s' : `selected ${pickToSelectedMs}ms after the pick`}); sandboxes created by the pick ${JSON.stringify(step.createdByPick)}`,
        screenshots: step.screenshots.filter((x) => /signed-out|after-pick/.test(x)),
        timings: { pickToSelectedMs },
        startedAt: pickStartedAt,
        durationMs: Date.now() - pickT0
      }
      results.steps.push(pick)
      if (pick.status === 'fail') {
        bug('auth.picker-sign-in', {
          title: 'Signing in from the Run-on picker\u2019s Orca Cloud row does not leave Orca Cloud selected',
          expected: 'signed in, Run on = Orca Cloud, nothing created',
          actual: pick.detail,
          repro: 'Fresh profile, signed out: New workspace -> Run on -> Orca Cloud ("Sign in to start a sandbox")',
          screenshot: pick.screenshots.at(-1)
        })
      }
      save()
    }
    if (step.afterPick.auth.state === 'connected') {
      // The signed-out Orca Cloud row ("Sign in to start a sandbox") signs in instead of selecting the
      // target, and the composer keeps Local Mac. A store sign-out also drops Orca Cloud from Run on, so
      // the build's sign-in card is only reachable when the session ends behind the composer's back:
      // select Orca Cloud signed in, then sign out in main only (as an expired/revoked session would).
      path_ = 'picker row signed in (Run on stayed Local Mac); re-picked Orca Cloud, session ended in main only, then Create'
      step.pickerSignedIn = true
      step.pickerSelectedAfterSignIn = /Orca Cloud/.test(step.afterPick.runOn ?? '')
      if (!step.pickerSelectedAfterSignIn) await pickOrcaCloud(step, d)
      await sleep(800)
      step.runOnSignedIn = await runOnValue(d)
      await page.evaluate(() => window.api.orcaProfiles.signOutCurrent())
      await sleep(1500)
      step.afterSignOut = { auth: await authState(), runOn: await runOnValue(d) }
    }
    step.path = path_
    step.runOnBeforeCreate = await runOnValue(d)
    if (!/Orca Cloud/.test(step.runOnBeforeCreate ?? '')) {
      await shot(step, 'run-on-not-orca-cloud')
      await page.keyboard.press('Escape')
      const noSandbox = Object.values(step.createdByPick).every((ids) => ids.length === 0)
      step.d1 = { pass: noSandbox, createdByPick: step.createdByPick }
      step.status = 'partial'
      step.detail = `signed out the composer cannot start an Orca Cloud build (Run on shows "${step.runOnBeforeCreate}"), so the build's sign-in card is unreachable; picker row "${runOn}" signs in instead; sandboxes created by the pick ${JSON.stringify(step.createdByPick)} (D-1 ${noSandbox ? 'pass' : 'FAIL'}); after pick ${JSON.stringify(step.afterPick)}`
      await store(async () => {
        const st = window.__store.getState()
        await st.signOutCurrentOrcaProfile()
        await window.__store.getState().connectCurrentOrcaProfile()
      })
      return
    }
    await fillName(d, name)
    await shot(step, 'composer')
    await clearToasts()
    const t0 = Date.now()
    await d.getByRole('button', { name: /Create workspace/ }).click()
    const card = await page
      .getByText('Sign in to use Orca Cloud', { exact: true })
      .first()
      .waitFor({ timeout: 60_000 })
      .then(() => true, () => false)
    step.timings.createToSignInCardMs = card ? Date.now() - t0 : null
    await sleep(3000)
    await shot(step, 'sign-in-card')
    step.cardText = redact(await page.locator('main').innerText().then((t) => t.match(/Sign in to use Orca Cloud[\s\S]{0,300}/)?.[0]?.replace(/\s+/g, ' ') ?? null, () => null))
    const whileCard = await sandboxIdsFor(watched)
    const createdWhileSignedOut = Object.fromEntries(watched.map((u) => [u, whileCard[u].filter((id) => !baseline[u].includes(id))]))
    step.createdWhileSignedOut = createdWhileSignedOut
    const d1NoSandbox = Object.values(createdWhileSignedOut).every((ids) => ids.length === 0)
    for (const [u, ids] of Object.entries(createdWhileSignedOut)) ids.forEach((id) => created.foreign.push({ user: u, id }))
    if (!card) {
      // What the build said instead: failure copy + the provisioning log.
      await page.getByRole('button', { name: 'View logs' }).first().click({ timeout: 3000 }).catch(() => {})
      await sleep(800)
      step.buildFailure = redact(await page.evaluate(() => (document.body.innerText.match(/Couldn.t start your cloud workspace[\s\S]{0,1500}/)?.[0] ?? '').replace(/\s+/g, ' ')))
      await shot(step, 'build-failure-logs')
      await page.getByRole('button', { name: 'Dismiss' }).first().click({ timeout: 3000 }).catch(() => {})
      // Re-sync renderer and main: a full sign-out then sign-in through the store.
      await store(async () => {
        const st = window.__store.getState()
        await st.signOutCurrentOrcaProfile()
        await window.__store.getState().connectCurrentOrcaProfile()
      })
      await sleep(1500)
      step.authAfterResync = await authState()
      step.status = 'fail'
      step.detail = `no "Sign in to use Orca Cloud" card within 60s of Create (signed out); sandboxes created while signed out: ${JSON.stringify(createdWhileSignedOut)}; toasts ${JSON.stringify((await toasts()).map(redact))}`
      step.detail += `; build showed: ${step.buildFailure?.slice(0, 500)}`
      bug('auth.signed-out-create', {
        title: 'Orca Cloud create after the session ended shows the generic "The sandbox didn\u2019t start" instead of the "Sign in to use Orca Cloud" card',
        expected: '"Sign in to use Orca Cloud" card with Sign in, nothing created',
        actual: step.detail,
        repro: `Fresh profile (ORCA_CLOUD_DEV_AUTH=1 + dev key), ${path_}`,
        screenshot: step.screenshots.at(-1)
      })
      return
    }
    // Sign in from the card's own button.
    const signInButtons = page.getByRole('button', { name: /^Sign in$/ }).filter({ visible: true })
    step.cardSignInButtons = await signInButtons.count()
    const t1 = Date.now()
    await signInButtons.last().click()
    let cardGoneMs = null
    const ready = await waitForWorkspaceReady(step, t1, {
      onTick: async () => {
        if (cardGoneMs === null && !(await page.getByText('Sign in to use Orca Cloud', { exact: true }).first().isVisible().catch(() => false))) {
          cardGoneMs = Date.now() - t1
        }
      }
    })
    step.timings.signInToCardGoneMs = cardGoneMs
    step.timings.signInToFirstTerminalOutputMs = ready.firstOutput
    step.timings.phases = ready.phases
    step.authAfter = await authState()
    await dismissNoise()
    await shot(step, 'after-sign-in-ready')
    const cardStill = await page.getByText('Sign in to use Orca Cloud', { exact: true }).first().isVisible().catch(() => false)
    const sb = await sandboxForWorkspace(t1)
    signedOutSandboxId = sb.newest?.id ?? null
    if (signedOutSandboxId) created.sandboxIds.add(signedOutSandboxId)
    step.sandboxId = signedOutSandboxId
    const others = await sandboxIdsFor(['desktop-dogfood', 'dev-user'])
    step.otherAccountsAfter = others
    const rowIsShown = await rowShown(name)
    if (rowIsShown) signedOutWs = name
    step.d1 = { pass: d1NoSandbox, createdWhileSignedOut }
    step.d4 = { pass: Boolean(signedOutSandboxId) && !cardStill && cardGoneMs !== null, ownedBy: signedOutSandboxId ? `dev:${USER}` : null, cardGoneMs, cardStill }
    step.status = step.d1.pass && step.d4.pass && rowIsShown ? 'pass' : 'fail'
    step.detail = `${path_}; card after ${step.timings.createToSignInCardMs}ms; sandboxes while signed out ${JSON.stringify(createdWhileSignedOut)} (D-1 ${step.d1.pass ? 'pass' : 'FAIL'}); sign in from card -> card gone ${cardGoneMs}ms, first terminal output ${ready.firstOutput}ms, sandbox ${signedOutSandboxId ?? 'NOT listed'} for dev:${USER} (D-4 ${step.d4.pass ? 'pass' : 'FAIL'}); row "${name}" shown: ${rowIsShown}; auth ${JSON.stringify(step.authAfter)}`
    if (!d1NoSandbox) {
      bug('auth.signed-out-create', {
        title: 'Signed-out Orca Cloud create still creates a sandbox',
        expected: 'no sandbox for any account until sign-in',
        actual: JSON.stringify(createdWhileSignedOut),
        repro: `Fresh profile, ${path_}`,
        screenshot: step.screenshots.find((s) => s.includes('sign-in-card'))
      })
    }
    if (!step.d4.pass) {
      bug('auth.signed-out-create', {
        title: 'Signing in from the Orca Cloud sign-in card does not carry the create through',
        expected: `card disappears, create proceeds, sandbox owned by dev:${USER}`,
        actual: `cardGone ${cardGoneMs}ms, card still visible ${cardStill}, sandbox ${signedOutSandboxId}`,
        repro: `Fresh profile, signed-out Orca Cloud create, click Sign in on the card`,
        screenshot: step.screenshots.at(-1)
      })
    }
  })

  let sandboxId = null

  await runStep('cli.desktop', 'Create an Orca Cloud workspace from the composer', async (step) => {
    if ((await authState()).state !== 'connected') {
      // The signed-out step failed before signing in; sign in so the rest of the run has an identity.
      await store(() => window.__store.getState().connectCurrentOrcaProfile())
      step.signedInHere = true
    }
    const d = await openComposer(step, 'picker')
    // A pick on the signed-out row signs in but leaves Run on as it was; pick again until it sticks.
    for (let i = 0; i < 3; i++) {
      step.pickRow = await pickOrcaCloud(step, d)
      await sleep(1200)
      if (/Orca Cloud/.test((await runOnValue(d)) ?? '')) break
      step.extraPicks = i + 1
    }
    await d.getByRole('button', { name: 'Later', exact: true }).click({ timeout: 1500 }).catch(() => {})
    step.composerHint = (await d.innerText()).match(/Hosted sandbox[\s\S]*?idle/)?.[0]?.replace(/\s+/g, ' ')
    await fillName(d, wsName)
    await shot(step, 'composer-orca-cloud')
    await clearToasts()
    const t0 = Date.now()
    await d.getByRole('button', { name: /Create workspace/ }).click()
    const { firstOutput, phases } = await waitForWorkspaceReady(step, t0)
    step.timings.createToFirstTerminalOutputMs = firstOutput
    step.timings.phases = phases
    await dismissNoise()
    await shot(step, 'ready-agent-terminal')
    // A plain shell next to the agent the composer launches: usable once it prints a prompt.
    const t1 = Date.now()
    await openNewTerminalTab()
    await page.waitForFunction(
      () => [...document.querySelectorAll('.xterm-rows')].some((r) => r.getBoundingClientRect().width > 0 && /\$\s*$/.test(r.innerText.trim())),
      null,
      { timeout: 60_000 }
    )
    step.timings.newTerminalToPromptMs = Date.now() - t1
    step.timings.createToShellPromptMs = Date.now() - t0
    const prompt = lastLine((await visibleTerminals()).pop() ?? '')
    step.prompt = prompt
    await shot(step, 'ready-shell')
    const sb = await sandboxForWorkspace(t0)
    sandboxId = sb.newest?.id ?? null
    if (sandboxId) created.sandboxIds.add(sandboxId)
    step.sandboxId = sandboxId
    step.sandboxOwnerOk = Boolean(sandboxId)
    // The cloud copy of the repo registers as its own project; its name should stay the repo's.
    const repoNames = await store(() => window.__store.getState().repos.map((r) => ({ name: r.displayName, path: r.path })))
    step.repos = repoNames
    const cloudy = /^ubuntu@/.test(prompt) && /orca\/workspaces/.test(prompt)
    step.status = cloudy && sandboxId ? 'pass' : 'partial'
    step.detail = `prompt "${prompt}"; sandbox ${sandboxId ?? 'NOT listed for ' + USER}; create->first terminal output ${firstOutput}ms, create->shell prompt ${step.timings.createToShellPromptMs}ms`
    if (!sandboxId) {
      bug('cli.desktop', {
        title: 'Created sandbox is not owned by the signed-in dev account',
        expected: `GET /v1/sandboxes as ${USER} lists the new sandbox`,
        actual: 'not listed',
        screenshot: step.screenshots.at(-1)
      })
    }
  })
  // ---- D-3: the VM checkout (folder "project") registers under the real project's name.
  await runStep('proj.cloud-name', 'After cloud creates: no project named "project"; the workspaces sit under orca-sandbox-push-test (D-3)', async (step) => {
    const snap = await store(() => {
      const s = window.__store.getState()
      return {
        repos: s.repos.map((r) => ({ id: r.id, name: r.displayName, path: r.path })),
        projects: (s.projects ?? []).map((p) => ({ id: p.id, name: p.displayName })),
        worktrees: Object.entries(s.worktreesByRepo ?? {}).flatMap(([repoId, ws]) => ws.map((w) => ({ repoId, name: w.displayName, path: w.path })))
      }
    })
    step.snapshot = snap
    const named = (x) => x.name === 'project'
    const projectNamed = [...snap.repos.filter(named), ...snap.projects.filter(named)]
    const lines = await page.evaluate(() => document.body.innerText.split('\n').map((l) => l.trim()).filter(Boolean))
    const headers = new Set([...snap.projects.map((p) => p.name), ...snap.repos.map((r) => r.name)])
    // Sidebar group: the nearest project header above the workspace row.
    const groupOf = (n) => {
      const i = lines.indexOf(n)
      for (let k = i - 1; k >= 0; k--) if (headers.has(lines[k])) return lines[k]
      return null
    }
    const placement = [wsName, signedOutWs].filter(Boolean).map((n) => {
      const w = snap.worktrees.find((x) => x.name === n)
      return { workspace: n, sidebarGroup: groupOf(n), repoName: w ? snap.repos.find((r) => r.id === w.repoId)?.name ?? null : null, path: w?.path ?? null }
    })
    step.placement = placement
    step.projectLabelLeaks = lines.filter((l) => l === 'project').length
    await shot(step, 'sidebar')
    const grouped = placement.length > 0 && placement.every((p) => p.sidebarGroup === 'orca-sandbox-push-test')
    const noProjectProject = !snap.projects.some(named) && !snap.repos.some(named)
    const ok = grouped && noProjectProject
    step.status = ok ? 'pass' : grouped ? 'partial' : 'fail'
    step.detail = `sidebar groups ${JSON.stringify(placement.map((p) => `${p.workspace} -> ${p.sidebarGroup}`))}; projects ${JSON.stringify(snap.projects.map((p) => p.name))}; repos ${JSON.stringify(snap.repos.map((r) => `${r.name}@${r.path}`))}; records named "project": ${projectNamed.length}; "project" labels on screen: ${step.projectLabelLeaks}`
    if (!ok) {
      bug('proj.cloud-name', {
        title: grouped
          ? 'Cloud checkout repo still registers as "project": the sidebar groups the workspace under orca-sandbox-push-test, but the repo record (setup-script nudge, file explorer header) says "project"'
          : 'Cloud create files the workspace under a project named "project"',
        expected: 'no repo or project named "project"; workspaces under orca-sandbox-push-test',
        actual: step.detail,
        repro: 'Create an Orca Cloud workspace for orca-sandbox-push-test; look at the sidebar project groups',
        screenshot: step.screenshots.at(-1)
      })
    }
  })

  /** D-2 proper: a not_found answer. Switching team re-scopes the token, so the control plane can't see a personal sandbox. */
  const notFoundDeleteStep = async () => {
    await runStep('life.delete-unconfirmed', 'Delete when the control plane answers not_found (team switched away from the sandbox owner) -> "couldn\'t confirm" error, row kept (D-2)', async (step) => {
      const { name, sandboxId: id } = await createExtraWorkspace(step, `${wsName}-nf`)
      const before = await authState()
      step.authBefore = before
      const orgs = await store(() => {
        const s = window.__store.getState()
        const p = s.orcaProfiles?.find((x) => x.id === s.activeOrcaProfileId)
        return (s.orcaProfileAuthStatus?.organizations ?? p?.cloud?.organizations ?? []).map((o) => o.orgId)
      })
      step.orgs = orgs
      const other = ['dev-acme', 'dev-personal'].find((o) => o !== before.orgId) ?? 'dev-acme'
      step.switchTo = other
      step.selectOrg = await store((o) => window.__store.getState().selectOrcaProfileOrg(o).then((r) => r?.status ?? null), other)
      await sleep(3000)
      step.authSwitched = await authState()
      // What the control plane says to the switched identity, signed exactly like the app's dev token.
      step.apiAsSwitched = await sandboxApiOrg(USER, step.authSwitched.orgId, 'GET', `/v1/sandboxes/${id}`)
      const rowVisible = await rowShown(name)
      step.rowVisibleAfterSwitch = rowVisible
      await shot(step, 'switched-team')
      if (!rowVisible) {
        step.status = 'fail'
        step.detail = `after switching team to ${other} (${JSON.stringify(step.selectOrg)}) the workspace row "${name}" is not shown, so Delete can't be tried; api as switched identity ${JSON.stringify(step.apiAsSwitched)}`
      } else {
        const o = await uiDelete(step, name, 'unconfirmed', 90_000, 20_000)
        step.outcome = o
        step.sandboxId = id
        const t1 = Date.now()
        const owner = await waitSandboxStatus(id, ['destroyed'], o.kind === 'removed' ? 90_000 : 5_000)
        step.ownerViewAfter = owner
        step.timings.uiDeleteMs = o.ms
        step.timings.rowGoneToDestroyedMs = o.kind === 'removed' && !owner.timedOut ? Date.now() - t1 : null
        const errText = o.kind === 'error' ? o.text : o.laterError?.text
        const unconfirmedKept = /couldn.t confirm/i.test(errText ?? '') && o.rowVisibleAfter && owner.status !== 'destroyed'
        const serverDestroyed = o.kind === 'removed' && !o.rowVisibleAfter && owner.status === 'destroyed'
        const surfacedFailure = /Couldn.t delete the sandbox/i.test([...(o.toasts ?? []), errText ?? ''].join(' '))
        step.result = serverDestroyed ? 'destroyed across teams' : unconfirmedKept ? 'unconfirmed, row kept' : surfacedFailure ? 'destroy failure surfaced' : 'silent'
        step.status = serverDestroyed || unconfirmedKept ? 'pass' : 'fail'
        step.detail = `team ${before.orgId ?? '(personal)'} -> ${step.authSwitched.orgId}; control plane GET as switched identity: ${JSON.stringify(step.apiAsSwitched)}; UI Delete -> ${o.kind}${o.text ? ` "${o.text}"` : ''} in ${o.ms}ms; later error: ${o.laterError ? JSON.stringify(o.laterError) : 'none'}; row kept: ${o.rowVisibleAfter}; owner (personal) sees ${owner.status}${owner.timedOut ? ' (not destroyed within 90s)' : ` ${step.timings.rowGoneToDestroyedMs ?? '-'}ms after the row went`} => ${step.result}`
        if (step.status === 'fail') {
          bug('life.delete-unconfirmed', {
            title: 'Delete after switching team away from the sandbox owner neither destroys the sandbox nor keeps the row with "couldn\u2019t confirm"',
            expected: 'server destroys it (creator can delete across teams); otherwise the row stays with "couldn\u2019t confirm", and a failed destroy shows a persistent "Couldn\u2019t delete the sandbox" toast with Try again',
            actual: step.detail,
            repro: 'Signed in, create an Orca Cloud workspace on the personal team, switch team to Acme Dev, Delete the workspace',
            screenshot: step.screenshots.at(-1)
          })
        }
      }
      step.restoreOrg = await store((o) => window.__store.getState().selectOrcaProfileOrg(o).then((r) => r?.status ?? null), before.orgId ?? null)
      await sleep(2000)
      step.authRestored = await authState()
      if (rowVisible) {
        await sleep(10_000)
        step.ownerViewAfterRestore = await sandboxStatus(id)
      }
    })
  }

  /** Sandbox destroyed out of band, then UI Delete, on the signed-out-create workspace. */
  const oobDeleteStep = async () => {
    await runStep('life.delete-after-oob-destroy', 'Sandbox destroyed out of band (API, same dev user) -> UI Delete', async (step) => {
      if (!signedOutWs || !signedOutSandboxId || !(await rowShown(signedOutWs))) {
        // No workspace left from the signed-out create: make one for this check.
        const extra = await createExtraWorkspace(step, `${wsName}-oob`)
        signedOutWs = extra.name
        signedOutSandboxId = extra.sandboxId
      }
      const r = await sandboxApi(USER, 'DELETE', `/v1/sandboxes/${signedOutSandboxId}`)
      step.oobDelete = { http: r.status, status: r.json?.sandbox?.status ?? r.json?.error ?? null }
      step.apiAfterOob = await sandboxStatus(signedOutSandboxId)
      const again = await sandboxApi(USER, 'DELETE', `/v1/sandboxes/${signedOutSandboxId}`)
      step.apiRepeatDelete = { http: again.status, status: again.json?.sandbox?.status ?? again.json?.error ?? null }
      await sleep(2000)
      const o = await uiDelete(step, signedOutWs, 'oob')
      step.outcome = o
      // The control plane keeps a tombstone: a repeat delete by the owner answers 200 destroyed, never
      // not_found. The sandbox really is gone, so the app is right to remove the row.
      const tombstone = step.apiRepeatDelete.http === 200 && step.apiRepeatDelete.status === 'destroyed'
      step.status = o.kind === 'removed' && !o.rowVisibleAfter ? 'pass' : 'fail'
      step.detail = `API delete -> ${JSON.stringify(step.oobDelete)}; repeat API delete -> ${JSON.stringify(step.apiRepeatDelete)} (tombstone: ${tombstone}); UI Delete -> ${o.kind}${o.text ? ` "${o.text}"` : ''} in ${o.ms}ms, row visible after: ${o.rowVisibleAfter}. ${tombstone ? 'Same-user out-of-band destroy cannot produce not_found, so this path does not exercise D-2; see life.delete-unconfirmed.' : ''}`
      if (step.status === 'fail') {
        bug('life.delete-after-oob-destroy', {
          title: 'Deleting a workspace whose sandbox was already destroyed does not remove the row',
          expected: 'control plane answers destroyed (tombstone), row removed',
          actual: step.detail,
          repro: 'Create an Orca Cloud workspace, DELETE its sandbox via the API as the same user, then Delete the workspace in the sidebar',
          screenshot: step.screenshots.at(-1)
        })
      }
      if (o.kind === 'removed') signedOutWs = null
    })
  }

  if (!sandboxId) results.notes.push('No sandbox id resolved for the workspace; lifecycle checks below rely on the UI only.')
  const workspaceRow = await rowShown(wsName)
  if (!workspaceRow) {
    for (const id of ['term.keystroke', 'acc.port-forward', 'acc.ssh', 'life.sleep-wake', 'life.transfer-local', 'life.destroy']) {
      results.steps.push({ id, status: 'skipped', detail: 'no cloud workspace row (create failed)', screenshots: [], timings: {} })
    }
    save()
    await notFoundDeleteStep()
    await oobDeleteStep()
    return
  }

  await runStep('term.keystroke', `First-keystroke latency in the cloud xterm (n=${KEY_SAMPLES})`, async (step) => {
    await focusTerminal()
    const samples = []
    for (let i = 0; i < KEY_SAMPLES; i++) samples.push(await measureKeystroke(`k${i}${String.fromCharCode(97 + i)}q`))
    step.timings.keystrokeToEchoMs = stats(samples)
    step.status = pct(samples, 95) < 250 ? 'pass' : 'partial'
    step.detail = `keydown -> char in xterm DOM: p50 ${pct(samples, 50)}ms, p95 ${pct(samples, 95)}ms (DOM renderer)`
    await shot(step, 'typed')
  })

  await runStep('acc.port-forward', `Ports panel detects :${PORT}, forward to localhost, ${HTTP_SAMPLES} GETs`, async (step) => {
    const preLocal = await fetch(`http://localhost:${PORT}/`).then((r) => r.status, () => 'closed')
    step.localPortBefore = preLocal
    await focusTerminal()
    await page.keyboard.type(`python3 -m http.server ${PORT}\n`)
    await page.waitForFunction((p) => [...document.querySelectorAll('.xterm-rows')].some((r) => r.innerText.includes(`port ${p}`)), PORT, { timeout: 20_000 })
    const tServe = Date.now()
    await page.locator('[aria-label^="Ports ("]').first().click()
    const portRow = page.getByText(`:${PORT}`, { exact: true }).first()
    await portRow.waitFor({ timeout: 60_000 })
    step.timings.serveToPanelRowMs = Date.now() - tServe
    let forwardedMs = null
    for (let i = 0; i < 120; i++) {
      const ok = await page.getByText(`localhost:${PORT}`).first().isVisible().catch(() => false)
      const open = await fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false)
      if (ok && open) {
        forwardedMs = Date.now() - tServe
        break
      }
      await sleep(250)
    }
    step.timings.serveToLocalhostReachableMs = forwardedMs
    step.autoForwardToast = (await toasts()).find((t) => /Forwarded/.test(t)) ?? null
    await shot(step, 'ports-panel')
    if (forwardedMs === null) {
      step.status = 'partial'
      step.detail = 'port row shown but localhost not reachable within 30s'
      return
    }
    const samples = []
    let server = null
    let body = ''
    for (let i = 0; i < HTTP_SAMPLES; i++) {
      const s = performance.now()
      const r = await fetch(`http://localhost:${PORT}/`)
      body = await r.text()
      samples.push(Math.round(performance.now() - s))
      server = r.headers.get('server')
    }
    step.timings.httpGetMs = stats(samples)
    const fromVm = /SimpleHTTP/i.test(server ?? '') && /README\.md/.test(body)
    step.status = fromVm && preLocal === 'closed' ? 'pass' : 'partial'
    step.detail = `auto-forwarded ${step.autoForwardToast ? `("${step.autoForwardToast.split('\n')[0]}")` : ''}; server "${server}"; listing has README.md: ${/README\.md/.test(body)}; GET p50 ${pct(samples, 50)}ms p95 ${pct(samples, 95)}ms`
    await focusTerminal()
    await page.keyboard.press('Control+C')
    await sleep(500)
  })

  await runStep('acc.ssh', 'Copy SSH Command / Open in editor / orca ssh', async (step) => {
    await openRowMenu(wsName)
    step.contextMenu = (await menuItems()).map((t) => t.split('\n')[0])
    await page.getByRole('menuitem', { name: 'Open in', exact: true }).hover()
    await sleep(600)
    const afterOpenIn = (await menuItems()).map((t) => t.replace(/\n/g, ' '))
    step.openInOptions = afterOpenIn.slice(step.contextMenu.length)
    await shot(step, 'open-in-menu')
    // A fresh menu: hovering from one open submenu to another does not swap them reliably.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await openRowMenu(wsName)
    await page.getByRole('menuitem', { name: 'SSH', exact: true }).hover()
    await sleep(600)
    const clipBefore = spawnSync('pbpaste', { encoding: 'utf8' }).stdout
    await clearToasts()
    const t0 = Date.now()
    await page.getByRole('menuitem', { name: 'Copy SSH Command' }).click()
    await page.waitForFunction(() => (window.__w9dToasts ?? []).some((t) => /copied|Couldn/.test(t)), null, { timeout: 90_000 })
    step.timings.copySshCommandMs = Date.now() - t0
    const tl = await toasts()
    await shot(step, 'ssh-copied')
    const clip = spawnSync('pbpaste', { encoding: 'utf8' }).stdout.trim()
    spawnSync('pbcopy', { input: clipBefore })
    step.toasts = tl.map(redact)
    const copied = /^ssh /.test(clip) ? clip : null
    step.sshCommand = redact(copied ?? '(not copied)')
    let sshOk = false
    if (copied) {
      const parts = copied.split(/\s+/).slice(1)
      const t1 = Date.now()
      const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', ...parts, 'echo ssh-ok $(hostname)'], { encoding: 'utf8', timeout: 90_000 })
      step.timings.sshRoundTripMs = Date.now() - t1
      step.sshResult = redact((r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | '))
      sshOk = /ssh-ok/.test(r.stdout)
    }
    const cli = path.join(repoRoot, 'out/cli/index.js')
    let cliOk = false
    if (existsSync(cli)) {
      const t2 = Date.now()
      const r = spawnSync(process.execPath, [cli, 'ssh', wsName, '--command', 'echo orca-ssh-ok $(hostname)'], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, ORCA_USER_DATA_PATH: results.app.userData }
      })
      step.timings.orcaSshMs = Date.now() - t2
      step.orcaSshResult = redact((r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | '))
      cliOk = /orca-ssh-ok/.test(r.stdout)
    } else {
      step.orcaSshResult = 'out/cli/index.js missing'
    }
    step.status = sshOk && cliOk ? 'pass' : sshOk || cliOk ? 'partial' : 'fail'
    step.detail = `Copy SSH Command -> ${step.sshCommand}; ssh: ${sshOk ? 'ok' : 'FAILED'} (${step.timings.sshRoundTripMs ?? '-'}ms); orca ssh: ${cliOk ? 'ok' : 'FAILED'} (${step.timings.orcaSshMs ?? '-'}ms); Open in offers ${JSON.stringify(step.openInOptions)} (not launched)`
  })

  await runStep('life.sleep-wake', `Suspend VM via UI, wake by opening the workspace, wake -> first echo (n=${WAKE_CYCLES})`, async (step) => {
    const suspendMs = []
    const wakeEchoMs = []
    const cycles = []
    for (let c = 0; c < WAKE_CYCLES; c++) {
      const cyc = { cycle: c + 1 }
      cycles.push(cyc)
      await openRowMenu(wsName)
      const ts = Date.now()
      await page.getByRole('menuitem', { name: /^(Suspend VM|Sleep)$/ }).first().click()
      await page.getByRole('dialog').getByRole('button', { name: /^(Sleep|Suspend)/ }).click({ timeout: 1500 }).catch(() => {})
      if (sandboxId) {
        const w = await waitSandboxStatus(sandboxId, ['suspended', 'stopped'], 120_000)
        cyc.suspend = w
        if (w.timedOut) throw new Error(`sandbox not suspended after 120s (last ${w.status})`)
      } else {
        await sleep(20_000)
      }
      cyc.suspendMs = Date.now() - ts
      suspendMs.push(cyc.suspendMs)
      await sleep(1500)
      if (c === 0) await shot(step, 'asleep')
      // Wake: open the workspace from the sidebar, keep typing until an echo makes it back.
      await clearToasts()
      const t0 = Date.now()
      await (await rowOf(wsName)).click()
      let wakingShot = c !== 0
      let echo = null
      let attempts = 0
      let lastType = 0
      const marker = `echo wake${c + 1}`
      while (Date.now() - t0 < 180_000) {
        if (!wakingShot && Date.now() - t0 > 1500) {
          await shot(step, 'waking')
          wakingShot = true
        }
        const terms = await visibleTerminals()
        if (terms.some((t) => t.includes(marker))) {
          echo = Date.now() - t0
          break
        }
        if (terms.length && Date.now() - lastType > 1500) {
          await focusTerminal().catch(() => {})
          await page.keyboard.press('Control+U')
          await page.keyboard.type(marker)
          attempts++
          lastType = Date.now()
        }
        await sleep(50)
      }
      if (echo === null) throw new Error(`no echo within 180s of wake (cycle ${c + 1})`)
      cyc.wakeToEchoMs = echo
      cyc.typeAttempts = attempts
      wakeEchoMs.push(echo)
      await page.keyboard.press('Control+U')
      if (sandboxId) cyc.statusAfterWake = (await sandboxStatus(sandboxId)).status
      cyc.prompt = lastLine((await visibleTerminals()).pop() ?? '')
      if (c === 0) await shot(step, 'woken')
      await sleep(2000)
    }
    step.cycles = cycles
    step.timings.suspendToSuspendedMs = stats(suspendMs)
    step.timings.wakeToFirstEchoMs = stats(wakeEchoMs)
    step.status = wakeEchoMs.length === WAKE_CYCLES ? 'pass' : 'partial'
    step.detail = `${wakeEchoMs.length}/${WAKE_CYCLES} cycles; suspend p50 ${pct(suspendMs, 50)}ms; wake->echo p50 ${pct(wakeEchoMs, 50)}ms p95 ${pct(wakeEchoMs, 95)}ms`
  })

  await runStep('life.transfer-local', 'Move to this computer', async (step) => {
    await openRowMenu(wsName)
    const items = (await menuItems()).map((t) => t.split('\n')[0])
    if (!items.includes('Move to this computer')) {
      step.status = 'partial'
      step.detail = `absent; menu: ${JSON.stringify(items)}`
      await page.keyboard.press('Escape')
      return
    }
    await clearToasts()
    const t0 = Date.now()
    await page.getByRole('menuitem', { name: 'Move to this computer' }).click()
    await sleep(800)
    const dlg = await page.getByRole('dialog').innerText().catch(() => null)
    if (dlg) {
      step.confirmDialog = dlg.replace(/\s+/g, ' ')
      await page.getByRole('dialog').getByRole('button', { name: /Move|Transfer|Continue/ }).first().click()
    }
    await shot(step, 'started')
    let local = null
    while (Date.now() - t0 < 180_000) {
      local = await store((n) => Object.values(window.__store.getState().worktreesByRepo ?? {}).flat().find((w) => !w.path.startsWith('/vercel') && w.path.includes(n)), wsName)
      if (local) break
      await sleep(500)
    }
    step.timings.transferMs = Date.now() - t0
    step.toasts = (await toasts()).map(redact)
    await sleep(1500)
    await shot(step, 'done')
    if (!local) throw new Error('no local worktree appeared within 180s')
    created.localPaths.push(local.path)
    step.localWorktree = { name: local.displayName, path: local.path, branch: local.branch }
    const files = existsSync(local.path) ? readdirSync(local.path) : []
    const cloudStill = sandboxId ? (await sandboxStatus(sandboxId)).status : null
    step.cloudStatusAfter = cloudStill
    step.status = files.includes('README.md') ? 'pass' : 'partial'
    step.detail = `local worktree "${local.displayName}" at ${local.path} (files: ${files.join(',')}); ${step.timings.transferMs}ms; cloud sandbox after: ${cloudStill} (copy, not move); no confirmation dialog: ${!dlg}`
    // Remove the local copy through the UI so the repo stays clean.
    await openRowMenu(local.displayName, 'local')
    await page.getByRole('menuitem', { name: /^Delete/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Delete( Workspace)?$/ }).click()
    await waitRowGone(local.displayName, 'local', 60_000)
    step.localCopyDeleted = !existsSync(local.path)
  })

  await runStep('life.delete-asleep-after-move', 'Delete right after Move to this computer (VM asleep): no wake; refused without force, offers Force delete; Force delete destroys the VM (#149)', async (step) => {
    await asleepDeleteCheck(step, wsName, sandboxId)
  })

  await runStep('life.delete-asleep', 'Delete a workspace put to sleep from the menu: no wake; Force delete destroys the VM (#149)', async (step) => {
    const ws = await createExtraWorkspace(step, `${wsName}-zz`)
    await openRowMenu(ws.name)
    await page.getByRole('menuitem', { name: /^(Suspend VM|Sleep)$/ }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: /^(Sleep|Suspend)/ }).click({ timeout: 1500 }).catch(() => {})
    const w = await waitSandboxStatus(ws.sandboxId, ['suspended', 'stopped'], 120_000)
    step.timings.sleepMs = w.ms
    if (w.timedOut) throw new Error(`not asleep after 120s (${w.status})`)
    await sleep(2000)
    await asleepDeleteCheck(step, ws.name, ws.sandboxId)
  })

  await runStep('life.destroy', 'Normal Delete of an awake cloud workspace reaches destroyed', async (step) => {
    const ws = await createExtraWorkspace(step, `${wsName}-del`)
    const o = await uiDelete(step, ws.name, 'delete', 120_000)
    step.outcome = o
    step.timings.uiRowGoneMs = o.kind === 'removed' ? o.ms : null
    const w = await waitSandboxStatus(ws.sandboxId, ['destroyed'], 120_000)
    step.timings.deleteToDestroyedMs = w.ms
    step.finalSandboxStatus = w.status
    step.sandboxId = ws.sandboxId
    step.status = o.kind === 'removed' && !o.rowVisibleAfter && !w.timedOut ? 'pass' : 'fail'
    step.detail = `UI Delete -> ${o.kind}${o.text ? ` "${o.text}"` : ''}, row gone ${step.timings.uiRowGoneMs}ms; sandbox ${ws.sandboxId} -> ${w.status} ${w.ms}ms after the row went`
    if (step.status === 'fail') {
      bug('life.destroy', { title: 'Normal Delete of an awake cloud workspace does not destroy it', expected: 'row gone, sandbox destroyed', actual: step.detail, repro: 'Create an Orca Cloud workspace, Delete, confirm', screenshot: step.screenshots.at(-1) })
    }
  })

  await notFoundDeleteStep()
  await oobDeleteStep()
}

async function cleanup() {
  const c = results.cleanup
  try {
    c.sandboxes = await deleteAllSandboxes(USER)
    for (const id of created.sandboxIds) {
      const s = await sandboxStatus(id)
      if (!['destroyed', 'deleted', 'not_found'].includes(s.status)) {
        const r = await sandboxApi(USER, 'DELETE', `/v1/sandboxes/${id}`)
        c.sandboxes.deleted.push({ id, forced: true, deleteStatus: r.status })
      }
    }
    for (const { user, id } of created.foreign) {
      const r = await sandboxApi(user, 'DELETE', `/v1/sandboxes/${id}`)
      c.sandboxes.deleted.push({ id, user, deleteStatus: r.status })
    }
    c.remaining = (await listSandboxes(USER)).items.map((s) => ({ id: s.id, status: s.status ?? s.state }))
  } catch (e) {
    c.sandboxError = e.message
  }
  try {
    await stopApp()
    c.appStopped = true
  } catch (e) {
    c.appStopError = e.message
  }
  // Orca's terminal daemon (and its shells) outlive the app by design; stop the ones bound to this
  // run's throwaway profile — nothing else matches that unique temp path.
  if (created.tmp) {
    await sleep(2000)
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout
    const pids = ps
      .split('\n')
      .filter((l) => l.includes(created.tmp))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((pid) => pid && pid !== process.pid)
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
    c.profileProcessesStopped = pids.length
  }
  for (const p of created.localPaths) {
    if (existsSync(p)) {
      c.leftoverLocal = [...(c.leftoverLocal ?? []), p]
    }
    try {
      rmdirSync(path.dirname(p)) // only succeeds when empty
    } catch {}
  }
  if (created.tmp && process.env.W9D_KEEP_PROFILE !== '1') rmSync(created.tmp, { recursive: true, force: true })
  save()
}

let exitCode = 0
try {
  await main()
} catch (e) {
  results.fatal = redact(e.stack ?? e.message)
  exitCode = 1
} finally {
  await cleanup()
  results.finishedAt = new Date().toISOString()
  results.summary = results.steps.map((s) => `${s.id}: ${s.status}`)
  save()
  log('results', path.join(artifactsDir, 'results.json'))
  process.exit(exitCode || (results.steps.some((s) => s.status === 'fail') ? 2 : 0))
}
