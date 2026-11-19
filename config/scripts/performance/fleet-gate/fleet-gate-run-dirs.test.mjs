import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { processIdentity } from './fleet-gate-cache-lock.mjs'
import { createRunDir, reapStaleRunDirs } from './fleet-gate-run-dirs.mjs'

const spawned = []
let root = null

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  if (root) {
    fs.rmSync(root, { recursive: true, force: true })
    root = null
  }
})

function sleeper(...args) {
  // Detached like a copy (its own process group) or a terminal daemon (its own session).
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', '--', ...args], {
    detached: true,
    stdio: 'ignore'
  })
  spawned.push(child)
  return child
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check) {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A run folder holding one copy (an app process plus its daemon), as a launched copy leaves it. */
async function runFolderWithCopy(dir) {
  const userDataDir = path.join(dir, 'old-0', 'user-data')
  fs.mkdirSync(path.join(userDataDir, 'daemon'), { recursive: true })
  const pidRecord = path.join(userDataDir, 'daemon', 'daemon.pid')
  const daemon = sleeper('--launch-nonce', 'nonce-1', '--pid-record', pidRecord)
  const app = sleeper()
  await until(() => processIdentity(daemon.pid) && processIdentity(app.pid))
  fs.writeFileSync(
    pidRecord,
    JSON.stringify({ pid: daemon.pid, launchNonce: 'nonce-1', startedAtMs: Date.now() })
  )
  fs.writeFileSync(
    path.join(dir, 'apps', String(app.pid)),
    JSON.stringify({ identity: processIdentity(app.pid), userDataDir })
  )
  return { app, daemon }
}

// The gate is Mac and Linux only; it reads process start times with ps.
it.skipIf(process.platform === 'win32')(
  "reaps a dead gate's copy and daemon but leaves a live gate's run alone",
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gate-runs-test-'))
    const dead = createRunDir('gate', root)
    // A gate killed with SIGKILL: its owner record names a process that no longer exists.
    fs.writeFileSync(path.join(dead, 'owner'), '999999 Thu Jan  1 00:00:00 1970')
    const deadCopy = await runFolderWithCopy(dead)
    const live = createRunDir('gate', root)
    const liveCopy = await runFolderWithCopy(live)

    expect(await reapStaleRunDirs(root)).toBe(1)

    await until(() => !alive(deadCopy.app.pid) && !alive(deadCopy.daemon.pid))
    expect([alive(deadCopy.app.pid), alive(deadCopy.daemon.pid)]).toEqual([false, false])
    expect(fs.existsSync(dead)).toBe(false)
    expect([alive(liveCopy.app.pid), alive(liveCopy.daemon.pid)]).toEqual([true, true])
    expect(fs.existsSync(live)).toBe(true)
  },
  30_000
)
