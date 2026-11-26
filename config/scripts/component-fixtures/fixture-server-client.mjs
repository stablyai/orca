import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  fixtureCacheDir,
  fixtureServerCodeStamp,
  repoRoot,
  serverLogPath,
  serverScriptPath,
  serverStatePath
} from './fixture-paths.mjs'
import {
  addStartLockOwner,
  isProcessAlive,
  releaseStartLock,
  startLockOwners,
  tryAcquireStartLock
} from './fixture-start-lock.mjs'

const STARTUP_TIMEOUT_MS = 120_000

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

function startServerProcess(lockToken) {
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
  // Same tick as spawn: the server owns the lock even if this launcher exits next.
  addStartLockOwner(lockToken, child.pid)
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
    // Why: another caller may already be stopping it. A server still serving refused the stop.
    const health = await readServerHealth(state, remaining())
    if (health?.pid === state.pid && !health.stopping) {
      throw error
    }
  }
  // Why the pid: a closed or garbled listener does not prove its browser has exited.
  while (isProcessAlive(state.pid)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the previous fixture server (pid ${state.pid}) to stop.`
      )
    }
    await delay(150)
  }
}

/** Returns the running fixture server, starting a detached one if needed. */
export async function ensureFixtureServer({ onStart } = {}) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  const lockToken = `${process.pid}-${randomUUID()}`
  let child
  let retiringPid
  let seenPid
  let waited = false
  try {
    while (Date.now() < deadline) {
      const state = readServerState()
      const health = await readServerHealth(state, Math.max(1, deadline - Date.now()))
      const identified = Boolean(health) && health.pid === state.pid
      const stopping = identified && health.stopping === true
      if (identified) {
        seenPid = state.pid
      }
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
      // A stopping server may still hold its port and browser until its process exits.
      if (stopping) {
        retiringPid = state.pid
      } else if (retiringPid && !isProcessAlive(retiringPid)) {
        retiringPid = undefined
      }
      if (!child && !retiringPid && tryAcquireStartLock(lockToken)) {
        const published = readServerState()
        if (published?.pid !== state?.pid || published?.url !== state?.url) {
          // Recheck the server published by a concurrent starter.
          releaseStartLock(lockToken)
          continue
        }
        // Why seenPid: a reset or garbled probe of a server we just saw does not mean it is gone.
        if (identified || (state?.pid === seenPid && isProcessAlive(seenPid))) {
          await stopPreviousServer(state, deadline)
        }
        onStart?.()
        child = startServerProcess(lockToken)
      }
      waited = true
      await delay(150)
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      // Why: a server that missed its startup deadline would keep the start lock with no waiter.
      child.kill()
    }
    const owners = startLockOwners().filter(
      (pid) => pid !== process.pid && pid !== child?.pid && isProcessAlive(pid)
    )
    const holder = owners.length > 0 ? ` The start lock is held by pid ${owners.join(', ')}.` : ''
    throw new Error(`Fixture server did not start in time.${holder} Log tail:\n${readLogTail()}`)
  } finally {
    // Releases only this call's lock; a lock owned by anyone else has another token.
    releaseStartLock(lockToken)
  }
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
