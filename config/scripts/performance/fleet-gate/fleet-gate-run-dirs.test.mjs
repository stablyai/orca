import { execFileSync, spawn } from 'node:child_process'
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
async function runFolderWithCopy(dir, marker) {
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
  // A copy whose launch never returned (the gate died mid-launch) and a helper such as Xvfb.
  const launching = sleeper(`--fleet-gate-copy=${marker}`)
  const helper = sleeper()
  await until(() => processIdentity(launching.pid) && processIdentity(helper.pid))
  fs.writeFileSync(
    path.join(dir, 'apps', `pending-${marker}`),
    JSON.stringify({ marker, userDataDir })
  )
  fs.writeFileSync(
    path.join(dir, 'helpers', String(helper.pid)),
    JSON.stringify({ identity: processIdentity(helper.pid) })
  )
  // A daemon's child that outlived its daemon: only the tree record an earlier stop wrote can still find it.
  const orphan = sleeper()
  await until(() => processIdentity(orphan.pid))
  const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(orphan.pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
  }).trim()
  fs.writeFileSync(
    path.join(userDataDir, 'daemon', 'fleet-gate-tree-1.json'),
    JSON.stringify([{ pid: orphan.pid, started }])
  )
  return [app, daemon, launching, helper, orphan].map((child) => child.pid)
}

// The gate is Mac and Linux only; it reads process start times with ps.
it.skipIf(process.platform === 'win32')(
  "reaps a dead gate's copies, daemon and helpers but leaves live and starting gates alone",
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gate-runs-test-'))
    const dead = createRunDir('gate', root)
    // A gate killed with SIGKILL: its owner record names a process that no longer exists.
    fs.writeFileSync(path.join(dead, 'owner'), '999999 Thu Jan  1 00:00:00 1970')
    const deadCopy = await runFolderWithCopy(dead, 'marker-dead')
    const live = createRunDir('gate', root)
    const liveCopy = await runFolderWithCopy(live, 'marker-live')
    // Another gate is creating this one right now: its owner file isn't written yet.
    const starting = fs.mkdtempSync(path.join(root, 'gate-'))

    expect(await reapStaleRunDirs(root)).toBe(1)

    await until(() => deadCopy.every((pid) => !alive(pid)))
    expect(deadCopy.map(alive)).toEqual([false, false, false, false, false])
    expect(fs.existsSync(dead)).toBe(false)
    expect(liveCopy.map(alive)).toEqual([true, true, true, true, true])
    expect(fs.existsSync(live)).toBe(true)
    expect(fs.existsSync(starting)).toBe(true)
  },
  30_000
)

it.skipIf(process.platform === 'win32')(
  "keeps a dead gate's folder while ps fails for its daemon, then reaps it once ps works",
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gate-runs-test-'))
    const dead = createRunDir('gate', root)
    const deadCopy = await runFolderWithCopy(dead, 'marker-busy')
    fs.writeFileSync(path.join(dead, 'owner'), '999999 Thu Jan  1 00:00:00 1970')
    // A busy host: only the daemon check (start time plus command line) fails, which proves nothing about it.
    const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim()
    const fakeBin = path.join(root, 'bin')
    fs.mkdirSync(fakeBin)
    fs.writeFileSync(
      path.join(fakeBin, 'ps'),
      `#!/bin/sh\ncase " $* " in *"lstart=,args="*" ${String(deadCopy[1])} "*) exit 2 ;; esac\nexec ${realPs} "$@"\n`,
      { mode: 0o755 }
    )
    const realPath = process.env.PATH
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath}`
    try {
      expect(await reapStaleRunDirs(root)).toBe(0)
    } finally {
      process.env.PATH = realPath
    }
    expect(fs.existsSync(dead)).toBe(true)
    expect(alive(deadCopy[1])).toBe(true)

    expect(await reapStaleRunDirs(root)).toBe(1)
    await until(() => deadCopy.every((pid) => !alive(pid)))
    expect(deadCopy.map(alive)).toEqual([false, false, false, false, false])
  },
  30_000
)
