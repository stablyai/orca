import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  fixtureCacheDir,
  fixtureServerCodeStamp,
  repoRoot,
  serverLockPath,
  serverLogPath,
  serverScriptPath,
  serverStatePath
} from './fixture-paths.mjs'

const STARTUP_TIMEOUT_MS = 120_000
const STALE_LOCK_MS = 150_000

function readServerState() {
  try {
    return JSON.parse(readFileSync(serverStatePath, 'utf8'))
  } catch {
    return null
  }
}

async function probeServer(state) {
  return Boolean(state) && (await readServerHealth(state))?.pid === state.pid
}

async function readServerHealth(state) {
  if (!state?.url) {
    return null
  }
  try {
    const response = await fetch(`${state.url}/__fixtures/health`, {
      signal: AbortSignal.timeout(2000)
    })
    const body = await response.json()
    return body.ok === true ? body : null
  } catch {
    return null
  }
}

function tryAcquireStartLock() {
  try {
    closeSync(openSync(serverLockPath, 'wx'))
    return true
  } catch {
    try {
      if (Date.now() - statSync(serverLockPath).mtimeMs > STALE_LOCK_MS) {
        unlinkSync(serverLockPath)
        return tryAcquireStartLock()
      }
    } catch {
      return tryAcquireStartLock()
    }
    return false
  }
}

function startServerProcess() {
  const log = openSync(serverLogPath, 'w')
  const child = spawn(process.execPath, [serverScriptPath], {
    cwd: repoRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: process.env
  })
  child.unref()
  closeSync(log)
  return child
}

function readLogTail() {
  try {
    return readFileSync(serverLogPath, 'utf8').split('\n').slice(-20).join('\n')
  } catch {
    return ''
  }
}

/** Returns the running fixture server, starting a detached one if needed. */
export async function ensureFixtureServer({ onStart } = {}) {
  const existing = readServerState()
  const health = await readServerHealth(existing)
  if (health && health.pid === existing?.pid) {
    if (health.codeStamp === fixtureServerCodeStamp()) {
      return { url: existing.url, started: false }
    }
    await callFixtureServer(existing.url, 'stop', {}).catch(() => {})
    await delay(300)
  }
  await mkdir(fixtureCacheDir, { recursive: true })
  let exited = false
  if (tryAcquireStartLock()) {
    onStart?.()
    startServerProcess().once('exit', () => {
      exited = true
    })
  }
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const state = readServerState()
    if (state && state.pid !== existing?.pid && (await probeServer(state))) {
      return { url: state.url, started: true }
    }
    if (exited) {
      throw new Error(`Fixture server exited during startup:\n${readLogTail()}`)
    }
    await delay(150)
  }
  throw new Error(`Fixture server did not start in time. Log tail:\n${readLogTail()}`)
}

export async function callFixtureServer(url, endpoint, body) {
  const response = await fetch(`${url}/__fixtures/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload.error ?? `Fixture server returned ${response.status}`)
  }
  return payload
}

export async function stopFixtureServer() {
  const state = readServerState()
  if (!(await probeServer(state))) {
    return false
  }
  await callFixtureServer(state.url, 'stop', {})
  return true
}
