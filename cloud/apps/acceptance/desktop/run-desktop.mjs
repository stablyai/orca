#!/usr/bin/env node
// Desktop (Electron) acceptance run for Orca Cloud: launches the dev Orca built from this checkout
// against the DEV cloud backends, drives the real UI over CDP (playwright-core), and writes
// results.json + screenshots into the artifacts dir given as argv[2].
//
//   node cloud/apps/acceptance/desktop/run-desktop.mjs <artifactsDir>
//
// Env: ORCA_CLOUD_SANDBOX_URL / ORCA_CLOUD_SANDBOX_DEV_KEY_FILE / ORCA_BILLING_API_URL override the
// dev defaults; W9D_USER (default w9-desktop) is the dev account; W9D_WAKE_CYCLES (default 5);
// W9D_SKIP_BUILD=1 skips the workspace-package/native/CLI prebuild.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream, readdirSync, rmdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { DEV_KEY_FILE, SANDBOX_URL, deleteAllSandboxes, listSandboxes, sandboxApi } from './sandbox-api.mjs'

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
const created = { sandboxIds: new Set(), localPaths: [] }
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
  const child = spawn(process.execPath, ['config/scripts/development/launch/run-electron-vite-dev.mjs'], {
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
  for (;;) {
    try {
      const targets = await (await fetch(`${instance.cdpUrl}/json`)).json()
      if (targets.some((t) => t.type === 'page' && t.url.startsWith(instance.rendererUrl))) break
    } catch {}
    if (Date.now() > deadline) throw new Error('renderer never appeared on CDP')
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

const store = (fn, arg) => page.evaluate(fn, arg)

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

function rowTitle(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.locator('[data-worktree-title-inline-rename]', { hasText: new RegExp(`^${esc}$`) }).first()
}
async function openRowMenu(name) {
  await page.keyboard.press('Escape').catch(() => {})
  await rowTitle(name).click({ button: 'right' })
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
  execFileSync('gh', ['repo', 'clone', REPO_SLUG, repoDir, '--', '--quiet'], { stdio: 'ignore' })
  created.tmp = tmp

  await runStep('setup', 'Launch dev Orca, sign in (dev auth), add repo', async (step) => {
    await launchApp(userData, 'first')
    // Sign in before any cloud call, then relaunch: the sandbox token cache is not keyed on the
    // signed-in identity (see bugs), so a fresh process guarantees the dev:<user> owner.
    await store(async () => {
      const s = window.__store.getState()
      await s.connectCurrentOrcaProfile?.()
      await s.fetchOrcaProfiles?.()
    })
    const who = await store(() => window.__store.getState().orcaProfiles?.map((p) => p.cloud?.userId ?? null))
    step.timings.firstLaunchMs = results.app.first.launchMs
    await stopApp()
    await launchApp(userData, 'main')
    step.timings.relaunchMs = results.app.main.launchMs
    await store(() => window.__store.getState().updateSettings({ terminalGpuAcceleration: 'off' }))
    await store(async (p) => {
      await window.api.repos.add({ path: p })
      await window.__store.getState().fetchRepos({})
    }, repoDir)
    const repos = await store(() => window.__store.getState().repos.map((r) => r.displayName))
    await installToastRecorder()
    step.status = who?.includes(USER) && repos.includes('orca-sandbox-push-test') ? 'pass' : 'partial'
    step.detail = `signed in as ${JSON.stringify(who)}; repos ${JSON.stringify(repos)}; terminal GPU off so xterm renders to DOM`
    await shot(step, 'home')
  })

  let sandboxId = null

  await runStep('cli.desktop', 'Create an Orca Cloud workspace from the composer', async (step) => {
    await page.getByRole('button', { name: 'New workspace', exact: true }).first().click()
    const d = page.getByRole('dialog')
    await d.waitFor()
    await d.getByRole('combobox', { name: 'Project' }).click()
    await page.getByRole('option', { name: /orca-sandbox-push-test/ }).first().click()
    await d.getByRole('combobox', { name: 'Run on' }).click()
    const targets = page.getByRole('listbox', { name: 'Run targets' })
    await targets.waitFor()
    step.runTargets = (await targets.getByRole('option').allInnerTexts()).map((t) => t.split('\n')[0])
    await shot(step, 'picker')
    await targets.getByRole('option', { name: /Orca Cloud/ }).click()
    await sleep(800)
    await d.getByRole('button', { name: 'Later', exact: true }).click({ timeout: 1500 }).catch(() => {})
    step.composerHint = (await d.innerText()).match(/Hosted sandbox[\s\S]*?idle/)?.[0]?.replace(/\s+/g, ' ')
    // Smart mode offers "Use … as workspace name"; the Name tab takes the text as is.
    await d.getByPlaceholder(/Type a name|Workspace name/).fill(wsName)
    await page.getByRole('option', { name: /as workspace name/ }).click({ timeout: 2000 }).catch(() => {})
    await shot(step, 'composer-orca-cloud')
    await clearToasts()
    const t0 = Date.now()
    await d.getByRole('button', { name: /Create workspace/ }).click()
    let provisioningShot = false
    let firstOutput = null
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
      if (!s.starting && s.xterm.some((n) => n > 0)) {
        firstOutput = t
        break
      }
      if (t > 300_000) throw new Error('workspace not ready in 300s')
      await sleep(100)
    }
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
    const renamed = repoNames.find((r) => r.path.startsWith('/vercel/') && r.name !== 'orca-sandbox-push-test')
    if (renamed) {
      const projectHeader = await page.getByText(renamed.name, { exact: true }).first().isVisible().catch(() => false)
      bug('cli.desktop', {
        title: `Cloud repo registers as "${renamed.name}" (basename of ${renamed.path}) and the sidebar project group / composer project list show that name instead of orca-sandbox-push-test`,
        expected: 'project keeps the repo name orca-sandbox-push-test',
        actual: `repo ${renamed.path} named "${renamed.name}"; sidebar header shows it: ${projectHeader}`,
        repro: 'Create an Orca Cloud workspace for a repo whose cloud checkout lands in /vercel/sandbox/project; look at the sidebar project header',
        screenshot: step.screenshots.at(-1)
      })
    }
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
  if (!sandboxId) results.notes.push('No sandbox id resolved for the workspace; lifecycle checks below rely on the UI only.')
  const workspaceRow = await rowTitle(wsName).isVisible().catch(() => false)
  if (!workspaceRow) {
    for (const id of ['term.keystroke', 'acc.port-forward', 'acc.ssh', 'life.sleep-wake', 'life.transfer-local', 'life.destroy']) {
      results.steps.push({ id, status: 'skipped', detail: 'no cloud workspace row (create failed)', screenshots: [], timings: {} })
    }
    save()
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
      await rowTitle(wsName).click()
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
    await openRowMenu(local.displayName)
    await page.getByRole('menuitem', { name: /^Delete/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Delete( Workspace)?$/ }).click()
    await rowTitle(local.displayName).waitFor({ state: 'detached', timeout: 60_000 })
    step.localCopyDeleted = !existsSync(local.path)
  })

  await runStep('life.destroy', 'Delete the cloud workspace through the UI and confirm the VM is gone', async (step) => {
    await openRowMenu(wsName)
    await page.getByRole('menuitem', { name: /^Delete/ }).click()
    const d = page.getByRole('dialog')
    step.dialog = (await d.innerText()).replace(/\s+/g, ' ')
    await shot(step, 'confirm')
    const t0 = Date.now()
    await d.getByRole('button', { name: /^Delete( Workspace)?$/ }).click()
    await rowTitle(wsName).waitFor({ state: 'detached', timeout: 60_000 })
    step.timings.uiRowGoneMs = Date.now() - t0
    await shot(step, 'after')
    if (!sandboxId) {
      step.status = 'partial'
      step.detail = 'row removed; no sandbox id to confirm against the API'
      return
    }
    const w = await waitSandboxStatus(sandboxId, ['destroyed', 'deleted', 'not_found'], 120_000)
    step.timings.deleteToDestroyedMs = w.ms
    step.finalSandboxStatus = w.status
    const listed = (await listSandboxes(USER)).items.some((s) => s.id === sandboxId)
    step.status = !w.timedOut ? 'pass' : 'fail'
    step.detail = `row gone in ${step.timings.uiRowGoneMs}ms; sandbox ${sandboxId} -> ${w.status} after ${w.ms}ms; still listed: ${listed}`
    if (w.timedOut) {
      bug('life.destroy', {
        title: 'Deleting a cloud workspace in the UI leaves the sandbox running',
        expected: 'sandbox destroyed',
        actual: `status ${w.status} 120s after delete`,
        screenshot: step.screenshots.at(-1)
      })
    }
  })
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
