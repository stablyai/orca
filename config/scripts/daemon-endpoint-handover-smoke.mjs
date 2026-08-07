/**
 * Endpoint handover smoke — guards the split-brain failure with real daemon processes.
 *
 * The failure it reproduces: a daemon whose endpoint name is reclaimed while it is still
 * alive used to delete the *replacement's* socket when it finally exited, because libuv
 * unlinks the pathname a server bound to with no ownership check. The replacement stayed
 * alive hosting PTYs that nothing could reach — terminals that acknowledge input and never
 * run it, and that a user cannot fix by restarting the app.
 *
 * Unix only: Windows named pipes are not directory entries, so the mechanism cannot occur.
 *
 * Usage: node config/scripts/daemon-endpoint-handover-smoke.mjs
 */
import { fork } from 'node:child_process'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const entryPath = join(repoRoot, 'out', 'main', 'daemon-entry.js')
const READY_TIMEOUT_MS = 20_000
const EXIT_TIMEOUT_MS = 15_000

const log = (msg) => console.log(`[endpoint-handover-smoke] ${msg}`)

function bootDaemon(tag, dir, socketPath) {
  const tokenPath = join(dir, `${tag}.token`)
  const pidPath = join(dir, `${tag}.pid`)
  const child = fork(
    entryPath,
    [
      '--socket',
      socketPath,
      '--token',
      tokenPath,
      '--pid-record',
      pidPath,
      '--launch-nonce',
      randomUUID(),
      '--entry-path',
      entryPath,
      '--app-version',
      'endpoint-handover-smoke'
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ORCA_USER_DATA_PATH: dir }
    }
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error(`daemon ${tag} never signaled ready.\nstderr:\n${stderr}`)),
      READY_TIMEOUT_MS
    )
    child.on('message', (msg) => {
      if (msg && typeof msg === 'object' && msg.type === 'ready') {
        clearTimeout(timer)
        resolveReady({ child, tokenPath, pidPath })
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectReady(new Error(`daemon ${tag} exited with ${code}.\nstderr:\n${stderr}`))
    })
  })
}

function isReachable(socketPath) {
  return new Promise((resolveReachable) => {
    const socket = connect({ path: socketPath })
    socket.on('connect', () => {
      socket.destroy()
      resolveReachable(true)
    })
    socket.on('error', () => resolveReachable(false))
  })
}

function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('daemon did not exit')), EXIT_TIMEOUT_MS)
    child.on('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
    child.kill('SIGTERM')
  })
}

async function main() {
  if (process.platform === 'win32') {
    log('SKIP: named pipes are not filesystem entries, so endpoint handover cannot occur')
    return
  }
  if (!existsSync(entryPath)) {
    throw new Error(`missing ${entryPath} — run \`pnpm build\` first`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'orca-endpoint-handover-'))
  const socketPath = join(dir, 'daemon.sock')
  let replaced
  let replacement
  try {
    replaced = await bootDaemon('replaced', dir, socketPath)
    const replacedInode = statSync(socketPath).ino
    log('daemon A published the endpoint')

    // Reclaim the endpoint name the way daemon replacement does, while A is still alive.
    unlinkSync(socketPath)
    replacement = await bootDaemon('replacement', dir, socketPath)
    const replacementInode = statSync(socketPath).ino
    if (replacedInode === replacementInode) {
      throw new Error('daemon B did not publish a distinct endpoint')
    }
    if (!(await isReachable(socketPath))) {
      throw new Error('daemon B is not reachable through the canonical endpoint')
    }
    log('daemon B took over the endpoint and is reachable')

    // A exits long after losing the endpoint. This is the step that used to break B.
    await killAndWait(replaced.child)
    await new Promise((r) => setTimeout(r, 300))

    if (!existsSync(socketPath) || statSync(socketPath).ino !== replacementInode) {
      throw new Error("daemon A's late exit deleted daemon B's endpoint")
    }
    if (!(await isReachable(socketPath))) {
      throw new Error('daemon B became unreachable after daemon A exited')
    }
    if (!existsSync(replacement.pidPath)) {
      throw new Error("daemon A's late exit removed daemon B's ownership record")
    }
    if (existsSync(replaced.pidPath)) {
      throw new Error('daemon A left its own ownership record behind')
    }

    log('PASS: the endpoint owner and the session host stayed the same daemon')
  } finally {
    for (const daemon of [replaced, replacement]) {
      if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) {
        try {
          daemon.child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[endpoint-handover-smoke] FAIL: ${error.message}`)
  process.exit(1)
})
