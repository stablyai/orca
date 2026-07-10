#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const cliPath =
  process.env.ORCA_COMPUTER_SMOKE_CLI_PATH ?? resolve(repoRoot, 'out', 'cli', 'index.js')
const args = new Set(process.argv.slice(2))
const requestedApps = valueFlag('--apps')
const includeScreenshot = args.has('--screenshot')
const launchRuntime = args.has('--launch')
const requireTarget = args.has('--require-target')
const session = valueFlag('--session') ?? `computer-smoke-${process.pid}`
const preferredApps = (
  requestedApps ??
  process.env.ORCA_COMPUTER_SMOKE_APPS ??
  'Finder,TextEdit,Text Editor,gedit,Notepad,Calculator,Microsoft Edge,Google Chrome,Safari,Slack,Spotify'
)
  .split(',')
  .map((app) => app.trim())
  .filter(Boolean)

if (!existsSync(cliPath)) {
  fail(`Missing built CLI at ${cliPath}. Run pnpm build:cli first.`)
}

if (launchRuntime) {
  const opened = unwrapResult(runCli(['open', '--json']))
  console.log(
    `computer-use smoke: runtime ${opened.runtime?.state ?? 'unknown'} (${opened.runtime?.runtimeId ?? 'unknown'})`
  )
}

const list = unwrapResult(runCli(['computer', 'list-apps', '--json']))
const apps = Array.isArray(list.apps) ? list.apps : []
const availableNames = new Set(apps.map((app) => String(app.name ?? '').toLowerCase()))
const availableBundles = new Set(
  apps.map((app) => String(app.bundleId ?? '').toLowerCase()).filter(Boolean)
)
const targets = preferredApps.filter(
  (app) => availableNames.has(app.toLowerCase()) || availableBundles.has(app.toLowerCase())
)

console.log(`computer-use smoke: ${apps.length} apps listed`)
if (targets.length === 0) {
  const message = `no preferred apps are running (${preferredApps.join(', ')})`
  if (requireTarget) {
    fail(message)
  }
  console.log(`computer-use smoke: ${message}`)
  process.exit(0)
}

let failures = 0
let successes = 0
for (const app of targets) {
  const result = runSnapshotSmoke(app)

  if (!result.ok) {
    if (result.skipped) {
      console.log(`computer-use smoke: ${app}: skipped (${result.reason})`)
      continue
    }
    failures += 1
    console.log(`computer-use smoke: ${app}: failed: ${result.error}`)
    continue
  }
  successes += 1

  const state = unwrapResult(result.value)
  const snapshot = state.snapshot
  const treeText = String(snapshot.treeText ?? '')
  const lineCount = treeText.split('\n').filter(Boolean).length
  const secondaryActions = (treeText.match(/Secondary Actions:/g) ?? []).length
  const settable = (treeText.match(/\bsettable\b/g) ?? []).length
  const screenshotState = state.screenshot
    ? `${state.screenshot.width}x${state.screenshot.height}`
    : 'missing'
  console.log(
    [
      `computer-use smoke: ${snapshot.app.name}`,
      `${snapshot.elementCount} elements`,
      `${lineCount} lines`,
      `${secondaryActions} secondary-action lines`,
      `${settable} settable elements`,
      `screenshot=${screenshotState}`
    ].join(' | ')
  )
}

if (failures > 0) {
  fail(`${failures} app snapshot smoke check(s) failed`)
}
if (requireTarget && successes === 0) {
  fail('no preferred app snapshots succeeded')
}

function runSnapshotSmoke(app) {
  const baseArgs = [
    'computer',
    'get-app-state',
    '--session',
    session,
    '--app',
    app,
    '--restore-window',
    ...(includeScreenshot ? [] : ['--no-screenshot']),
    '--json'
  ]
  const initial = runCli(baseArgs, { allowFailure: true })
  if (initial.ok) {
    return initial
  }
  const error = parseCliFailure(initial.error)
  if (error?.code === 'window_not_found') {
    return { ok: false, skipped: true, reason: error.message }
  }
  return initial
}

function parseCliFailure(raw) {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed.error ?? null
  } catch {
    return { code: 'runtime_error', message: String(raw) }
  }
}

function valueFlag(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return null
  }
  return process.argv[index + 1] ?? null
}

function runCli(cliArgs, options = {}) {
  const child = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH:
        process.env.ORCA_COMPUTER_SMOKE_USER_DATA_PATH ?? defaultDevUserDataPath()
    }
  })
  if (child.status !== 0) {
    const error = (child.stderr || child.stdout || `exit ${child.status}`).trim()
    if (options.allowFailure) {
      return { ok: false, error }
    }
    fail(error)
  }
  try {
    return options.allowFailure
      ? { ok: true, value: JSON.parse(child.stdout) }
      : JSON.parse(child.stdout)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(`Could not parse CLI JSON for ${cliArgs.join(' ')}: ${detail}\n${child.stdout}`)
  }
}

function defaultDevUserDataPath() {
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'orca-dev')
  }
  if (process.platform === 'win32') {
    return resolve(process.env.APPDATA ?? resolve(homedir(), 'AppData', 'Roaming'), 'orca-dev')
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'orca-dev')
}

function unwrapResult(value) {
  if (value && typeof value === 'object' && 'result' in value) {
    return value.result
  }
  return value
}

function fail(message) {
  console.error(`computer-use smoke: ${message}`)
  process.exit(1)
}
