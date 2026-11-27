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

function checkPreservedServer(state, health, stamp) {
  if (health && health.pid === state?.pid) {
    if (health.codeStamp !== stamp) {
      throw new Error(
        `Incompatible fixture server is already running at ${state.url} (PID ${state.pid})`
      )
    }
    return
  }
  if (!Number.isSafeInteger(state?.pid) || state.pid <= 0) {
    return
  }
  try {
    process.kill(state.pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') {
      return
    }
  }
  throw new Error(`Cannot verify the live fixture server at ${state.url} (PID ${state.pid})`)
}

/** With preserveExisting, a caller may close only the server it started. */
export async function ensureFixtureServer({ onStart, preserveExisting = false } = {}) {
  const stamp = fixtureServerCodeStamp()
  const existing = readServerState()
  const health = await readServerHealth(existing)
  if (preserveExisting) {
    checkPreservedServer(existing, health, stamp)
  }
  if (health && health.pid === existing?.pid) {
    if (health.codeStamp === stamp) {
      return { url: existing.url, started: false }
    }
    await callFixtureServer(existing.url, 'stop', {}).catch(() => {})
    await delay(300)
  }
  await mkdir(fixtureCacheDir, { recursive: true })
  let child
  let exited
  let ownedUrl
  let startupError
  let done = false
  const close = async () => {
    if (!child || done) {
      return
    }
    child.ref()
    if (ownedUrl && (await probeServer({ url: ownedUrl, pid: child.pid }))) {
      await callFixtureServer(ownedUrl, 'stop', {}).catch(() => child.kill())
    } else {
      child.kill()
    }
    await exited
  }
  try {
    if (tryAcquireStartLock()) {
      try {
        // Another client may have published the server and released the lock since our first probe.
        const candidate = readServerState()
        if (candidate?.pid !== existing?.pid) {
          const live = await readServerHealth(candidate)
          if (preserveExisting) {
            checkPreservedServer(candidate, live, stamp)
          }
          if (live && live.pid === candidate.pid) {
            return { url: candidate.url, started: false }
          }
        }
        onStart?.()
        child = startServerProcess()
        exited = new Promise((resolve) => {
          child.once('close', () => {
            done = true
            resolve()
          })
          child.once('error', (error) => {
            startupError = error
          })
        })
      } finally {
        if (!child) {
          unlinkSync(serverLockPath)
        }
      }
    }
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (done || startupError) {
        throw new Error(`Fixture server exited during startup:\n${readLogTail()}`, {
          cause: startupError
        })
      }
      const state = readServerState()
      if (state && state.pid !== existing?.pid) {
        const live = await readServerHealth(state)
        if (live?.pid === state.pid) {
          if (live.codeStamp !== stamp && preserveExisting) {
            throw new Error(
              `Incompatible fixture server is already running at ${state.url} (PID ${live.pid})`
            )
          }
          const started = state.pid === child?.pid
          if (started) {
            ownedUrl = state.url
          }
          return { url: state.url, started, close: started ? close : undefined }
        }
      }
      await delay(150)
    }
    throw new Error(`Fixture server did not start in time. Log tail:\n${readLogTail()}`)
  } catch (error) {
    await close()
    if (startupError) {
      unlinkSync(serverLockPath)
    }
    throw error
  }
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
