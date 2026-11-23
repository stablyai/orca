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

async function readServerHealth(state, timeoutMs = STARTUP_TIMEOUT_MS) {
  if (!state?.url) {
    return null
  }
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(`${state.url}/__fixtures/health`, {
      signal
    })
    const body = await response.json()
    return body.ok === true ? body : null
  } catch (error) {
    if (signal.aborted) {
      throw new Error('Timed out waiting for the existing fixture server to answer.', {
        cause: error
      })
    }
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
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  const codeStamp = fixtureServerCodeStamp()
  let child
  let waited = false
  while (Date.now() < deadline) {
    const state = readServerState()
    const health = await readServerHealth(state, Math.max(1, deadline - Date.now()))
    const identified = health && health.pid === state.pid
    if (identified && health.codeStamp === codeStamp) {
      return { url: state.url, started: waited }
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Fixture server exited during startup:\n${readLogTail()}`)
    }
    if (!waited) {
      await mkdir(fixtureCacheDir, { recursive: true })
    }
    if (!child && tryAcquireStartLock()) {
      const published = readServerState()
      if (published?.pid !== state?.pid || published?.url !== state?.url) {
        // Recheck the server published by a concurrent starter.
        unlinkSync(serverLockPath)
        continue
      }
      try {
        if (identified) {
          await callFixtureServer(
            state.url,
            'stop',
            {},
            AbortSignal.timeout(Math.max(1, deadline - Date.now()))
          )
          while (
            (await readServerHealth(state, Math.max(1, deadline - Date.now())))?.pid === state.pid
          ) {
            if (Date.now() >= deadline) {
              throw new Error('Timed out waiting for the previous fixture server to stop.')
            }
            await delay(150)
          }
        }
        onStart?.()
        child = startServerProcess()
      } catch (error) {
        unlinkSync(serverLockPath)
        throw error
      }
    }
    waited = true
    await delay(150)
  }
  throw new Error(`Fixture server did not start in time. Log tail:\n${readLogTail()}`)
}

export async function callFixtureServer(url, endpoint, body, signal) {
  const response = await fetch(`${url}/__fixtures/${endpoint}`, {
    signal,
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
  const health = await readServerHealth(state)
  if (!health || health.pid !== state?.pid) {
    return false
  }
  await callFixtureServer(state.url, 'stop', {})
  return true
}
