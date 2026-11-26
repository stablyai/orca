import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  fixtureCacheDir,
  fixtureServerCodeStamp,
  repoRoot,
  serverLogPath,
  serverScriptPath,
  serverStatePath,
  startGuardPath
} from './fixture-paths.mjs'
import { SERVER_BUSY_EXIT_CODE, tryHoldLock } from './fixture-locks.mjs'

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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function startServerProcess(cancelPath) {
  const log = openSync(serverLogPath, 'w')
  const child = spawn(process.execPath, [serverScriptPath], {
    cwd: repoRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ORCA_FIXTURES_CANCEL_FILE: cancelPath }
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
  // Held while this call decides on and starts a server, until that server is up or gone.
  let startLock = null
  let child
  let childCancelPath
  let retiringPid
  // The last server this call saw answer as itself; it must exit before a replacement starts.
  let seen
  let readyPid
  let waited = false
  try {
    while (Date.now() < deadline) {
      const state = readServerState()
      const health = await readServerHealth(state, Math.max(1, deadline - Date.now()))
      const identified = Boolean(health) && health.pid === state.pid
      const stopping = identified && health.stopping === true
      if (identified) {
        seen = { pid: state.pid, url: state.url }
      }
      // Why after the probe: a script edit while it was in flight must not admit old code.
      if (identified && !stopping && health.codeStamp === fixtureServerCodeStamp()) {
        readyPid = state.pid
        return { url: state.url, started: waited }
      }
      // Our child is up with an older stamp, was stopped (exit 0) by a client replacing it,
      // or found another server owning the checkout.
      if (
        child &&
        ((identified && health.pid === child.pid) ||
          child.exitCode === 0 ||
          child.exitCode === SERVER_BUSY_EXIT_CODE)
      ) {
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
      if (!child && !retiringPid) {
        startLock ??= tryHoldLock(startGuardPath)
      }
      if (!child && !retiringPid && startLock) {
        const published = readServerState()
        if (published?.pid !== state?.pid || published?.url !== state?.url) {
          // Recheck the server published by a concurrent starter.
          continue
        }
        // Why seen: the record can vanish (an older server removes it on stop) while it lives.
        const previous = identified ? state : seen && isProcessAlive(seen.pid) ? seen : null
        if (previous) {
          await stopPreviousServer(previous, deadline)
        }
        onStart?.()
        // A path unique to this start, so a cancel request can never be mistaken for a stale one.
        childCancelPath = path.join(fixtureCacheDir, `cancel-${randomUUID()}`)
        child = startServerProcess(childCancelPath)
      }
      waited = true
      await delay(150)
    }
    // Why: another caller may already have returned our server just before the deadline.
    const state = readServerState()
    const health = child ? await readServerHealth(state, 1000).catch(() => null) : null
    if (
      child &&
      health &&
      health.pid === child.pid &&
      !health.stopping &&
      health.codeStamp === fixtureServerCodeStamp()
    ) {
      readyPid = child.pid
      return { url: state.url, started: true }
    }
    throw new Error(`Fixture server did not start in time. Log tail:\n${readLogTail()}`)
  } finally {
    try {
      if (child && child.pid !== readyPid && child.exitCode === null && child.signalCode === null) {
        // Why: a server this call started but is not returning holds, or waits for, the guard.
        // SIGTERM runs its own teardown on POSIX. On Windows kill() would skip that teardown, so
        // the server is asked through its cancel file instead.
        if (process.platform !== 'win32') {
          child.kill()
        } else {
          try {
            writeFileSync(childCancelPath, '')
          } catch {}
        }
      }
    } finally {
      startLock?.release()
    }
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
