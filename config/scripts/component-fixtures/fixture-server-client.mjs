import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  fixtureCacheDir,
  fixtureServerCodeStamp,
  releaseStartLock,
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

function tryAcquireStartLock(token) {
  let fd
  try {
    fd = openSync(serverLockPath, 'wx')
  } catch {
    try {
      if (Date.now() - statSync(serverLockPath).mtimeMs > STALE_LOCK_MS) {
        unlinkSync(serverLockPath)
        return tryAcquireStartLock(token)
      }
    } catch {
      return tryAcquireStartLock(token)
    }
    return false
  }
  try {
    writeSync(fd, token)
  } finally {
    closeSync(fd)
  }
  return true
}

function startServerProcess(lockToken) {
  // Why: the stale-lock lease covers the child's startup, not the previous server's teardown.
  const now = new Date()
  utimesSync(serverLockPath, now, now)
  const log = openSync(serverLogPath, 'w')
  const child = spawn(process.execPath, [serverScriptPath], {
    cwd: repoRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ORCA_FIXTURES_LOCK_TOKEN: lockToken }
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

async function stopPreviousServer(state, deadline) {
  const remaining = () => Math.max(1, deadline - Date.now())
  try {
    await callFixtureServer(state.url, 'stop', {}, AbortSignal.timeout(remaining()))
  } catch (error) {
    // Why: another caller may already have stopped it. Only a server still answering is a failure.
    if ((await readServerHealth(state, remaining()))?.pid === state.pid) {
      throw error
    }
    return
  }
  while ((await readServerHealth(state, remaining()))?.pid === state.pid) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the previous fixture server to stop.')
    }
    await delay(150)
  }
}

/** Returns the running fixture server, starting a detached one if needed. */
export async function ensureFixtureServer({ onStart } = {}) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  const lockToken = `${process.pid}-${randomUUID()}`
  let child
  let waited = false
  while (Date.now() < deadline) {
    const state = readServerState()
    const health = await readServerHealth(state, Math.max(1, deadline - Date.now()))
    const identified = Boolean(health) && health.pid === state.pid
    const stopping = identified && health.stopping === true
    // Why after the probe: a script edit while it was in flight must not admit old code.
    if (identified && !stopping && health.codeStamp === fixtureServerCodeStamp()) {
      return { url: state.url, started: waited }
    }
    // Our child is up with an older stamp, or a client stopped it (exit 0) to replace it.
    if (child && ((identified && health.pid === child.pid) || child.exitCode === 0)) {
      child = undefined
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Fixture server exited during startup:\n${readLogTail()}`)
    }
    if (!waited) {
      await mkdir(fixtureCacheDir, { recursive: true })
    }
    // A stopping server still holds its port and browser, so wait for it to exit.
    if (!child && !stopping && tryAcquireStartLock(lockToken)) {
      const published = readServerState()
      if (published?.pid !== state?.pid || published?.url !== state?.url) {
        // Recheck the server published by a concurrent starter.
        releaseStartLock(lockToken)
        continue
      }
      try {
        if (identified) {
          await stopPreviousServer(state, deadline)
        }
        onStart?.()
        child = startServerProcess(lockToken)
      } catch (error) {
        releaseStartLock(lockToken)
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
