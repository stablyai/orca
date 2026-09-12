// HOW TO RUN: copy this file, relay-gc-host.cjs, the built `relay.js` and its `.version` into one
// directory on the target host (they resolve each other via import.meta.dirname), install a
// matching `node-pty` beside them, then `node <this file>`. Results are exact counts and
// post-collection heap figures; nothing here asserts on a duration.
// Focused follow-up: after pty.shutdown, poll until PTY state actually returns to baseline.
// The churn probe used a fixed 1.5s settle, which was too short to tell "not retired" from
// "not retired yet". This polls instead of guessing.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const VERSION = readFileSync(join(HERE, '.version'), 'utf8').trim()
const RUNDIR = '/tmp/orca-pty-retire-probe'
const SOCK = join(RUNDIR, 'relay.sock')
const HEADER = 13
const PTYS = 20

rmSync(RUNDIR, { recursive: true, force: true })
mkdirSync(RUNDIR, { recursive: true })

const enc = (type, id, ack, payload) => {
  const h = Buffer.alloc(HEADER)
  h[0] = type
  h.writeUInt32BE(id, 1)
  h.writeUInt32BE(ack, 5)
  h.writeUInt32BE(payload.length, 9)
  return Buffer.concat([h, payload])
}
const dec = (buf) => {
  const out = []
  let off = 0
  while (buf.length - off >= HEADER) {
    const len = buf.readUInt32BE(off + 9)
    if (buf.length - off - HEADER < len) {
      break
    }
    out.push({ type: buf[off], payload: buf.subarray(off + HEADER, off + HEADER + len) })
    off += HEADER + len
  }
  return { frames: out, rest: buf.subarray(off) }
}

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK)
    let buf = Buffer.alloc(0)
    sock.on('error', reject)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      const { frames, rest } = dec(buf)
      buf = rest
      for (const f of frames) {
        if (f.type !== 2) {
          continue
        }
        const m = JSON.parse(f.payload.toString())
        if (m.type === 'orca-relay-handshake-ok') {
          sock.removeAllListeners('data')
          sock._carry = buf
          sock._seq = 0
          resolve(sock)
        } else {
          reject(new Error(m.type))
        }
      }
    })
    sock.on('connect', () =>
      sock.write(
        enc(
          2,
          0,
          0,
          Buffer.from(JSON.stringify({ type: 'orca-relay-handshake', version: VERSION }))
        )
      )
    )
  })
}

let rpcId = 1
function rpc(sock, method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = rpcId++
    let buf = sock._carry ?? Buffer.alloc(0)
    sock._carry = Buffer.alloc(0)
    const timer = setTimeout(() => {
      sock.off('data', onData)
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const { frames, rest } = dec(buf)
      buf = rest
      for (const f of frames) {
        if (f.type !== 1) {
          continue
        }
        let m
        try {
          m = JSON.parse(f.payload.toString())
        } catch {
          continue
        }
        if (m.id === id) {
          clearTimeout(timer)
          sock.off('data', onData)
          sock._carry = buf
          if (m.error) {
            reject(new Error(JSON.stringify(m.error)))
          } else {
            resolve(m.result)
          }
        }
      }
    }
    sock.on('data', onData)
    sock.write(
      enc(1, ++sock._seq, 0, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })))
    )
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fds = (pid) => {
  try {
    return readdirSync(`/proc/${pid}/fd`).length
  } catch {
    return -1
  }
}

async function main() {
  const child = spawn(
    process.execPath,
    [
      join(HERE, 'relay.js'),
      '--detached',
      '--sock-path',
      SOCK,
      '--grace-time',
      '0',
      '--log-file',
      join(RUNDIR, 'relay.log')
    ],
    {
      cwd: RUNDIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ORCA_RELAY_EMPTY_STARTUP_GRACE_MS: '3600000',
        ORCA_RELAY_IDLE_GRACE_MS: '3600000'
      }
    }
  )
  child.stderr.on('data', () => {})
  child.stdout.on('data', () => {})
  for (let i = 0; i < 150 && !existsSync(SOCK); i++) {
    await sleep(100)
  }
  await sleep(500)
  const pid = child.pid
  const obs = await connect()

  const base = await rpc(obs, 'relay.status', {})
  const out = { baselineFds: fds(pid), baselinePtys: base.ptys.active }

  const holder = await connect()
  const ids = []
  for (let i = 0; i < PTYS; i++) {
    const r = await rpc(holder, 'pty.spawn', {
      cwd: RUNDIR,
      cols: 80,
      rows: 24,
      shell: '/bin/sh',
      args: []
    })
    ids.push(r.id)
  }
  out.afterSpawn = { fds: fds(pid), ptys: (await rpc(obs, 'relay.status', {})).ptys.active }

  holder.destroy()
  await sleep(1500)
  out.afterUncleanDrop = { fds: fds(pid), ptys: (await rpc(obs, 'relay.status', {})).ptys.active }

  for (const id of ids) {
    await rpc(obs, 'pty.shutdown', { id })
  }

  // Poll rather than assume a settle window.
  const started = Date.now()
  let polls = 0
  let ptys = -1
  let f = -1
  while (Date.now() - started < 60000) {
    polls++
    ptys = (await rpc(obs, 'relay.status', {})).ptys.active
    f = fds(pid)
    if (ptys === 0 && f === out.baselineFds) {
      break
    }
    await sleep(500)
  }
  out.afterShutdown = { fds: f, ptys, polls, elapsedMs: Date.now() - started }

  console.log(JSON.stringify(out, null, 1))
  obs.destroy()
  child.kill('SIGKILL')
  await sleep(300)
  console.log(`RELAY_PID=${pid}`)
}

main().catch((e) => {
  console.error(`PROBE_FAILED: ${e.message}`)
  process.exit(1)
})
