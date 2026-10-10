// HOW TO RUN: copy this file, relay-gc-host.cjs, the built `relay.js` and its `.version` into one
// directory on the target host (they resolve each other via import.meta.dirname), install a
// matching `node-pty` beside them, then `node <this file>`. Results are exact counts and
// post-collection heap figures; nothing here asserts on a duration.
// Discriminator: is retained-after-GC heap proportional to churn (a leak) or fixed (init cost)?
// Repeats spawn-20-PTYs / shutdown-all / forced-GC many times and reports the retained heap each
// cycle. A per-PTY or per-connection leak climbs with the cycle count; init cost plateaus.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { readFileSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const VERSION = readFileSync(join(HERE, '.version'), 'utf8').trim()
const RUNDIR = '/tmp/orca-pty-gc-cycles'
const SOCK = join(RUNDIR, 'relay.sock')
const GC_REPORT = join(RUNDIR, 'gc.json')
const HEADER = 13
const PTYS = 20
// Why 30 and not 10: the first ~10 cycles are still inside V8's JIT warmup, where retained heap
// climbs about 0.064 MB/cycle and looks like a linear leak. It decays to ~0.017 MB/cycle over the
// second decade and is flat across the last three. Reading 10 cycles alone produces a false leak.
const CYCLES = Number.parseInt(process.env.ORCA_PROBE_CYCLES ?? '30', 10)

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
function rpc(sock, method, params, timeoutMs = 25000) {
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

async function forcedGc(pid) {
  writeFileSync(GC_REPORT, '')
  process.kill(pid, 'SIGUSR2')
  for (let i = 0; i < 80; i++) {
    await sleep(100)
    const raw = readFileSync(GC_REPORT, 'utf8')
    if (raw.trim()) {
      return JSON.parse(raw).mem
    }
  }
  return null
}

async function main() {
  const child = spawn(
    process.execPath,
    [
      '--expose-gc',
      join(HERE, 'gc-host.cjs'),
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
        ORCA_GC_REPORT: GC_REPORT,
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
  const rows = []

  const m0 = await forcedGc(pid)
  rows.push({
    cycle: 0,
    ptysCreatedSoFar: 0,
    connsSoFar: 1,
    ptys: 0,
    fds: fds(pid),
    heapAfterGcMb: +(m0.heapUsed / 1048576).toFixed(3)
  })

  let created = 0
  for (let c = 1; c <= CYCLES; c++) {
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
      created++
    }
    holder.destroy()
    await sleep(500)
    for (const id of ids) {
      await rpc(obs, 'pty.shutdown', { id })
    }
    // poll to a real baseline rather than guessing a settle
    for (let i = 0; i < 120; i++) {
      const st = await rpc(obs, 'relay.status', {})
      if (st.ptys.active === 0) {
        break
      }
      await sleep(500)
    }
    const m = await forcedGc(pid)
    const st = await rpc(obs, 'relay.status', {})
    rows.push({
      cycle: c,
      ptysCreatedSoFar: created,
      connsSoFar: 1 + c,
      ptys: st.ptys.active,
      fds: fds(pid),
      heapAfterGcMb: +(m.heapUsed / 1048576).toFixed(3)
    })
  }

  console.log(JSON.stringify(rows, null, 1))
  obs.destroy()
  child.kill('SIGKILL')
  await sleep(300)
  console.log(`RELAY_PID=${pid}`)
}

main().catch((e) => {
  console.error(`PROBE_FAILED: ${e.message}`)
  process.exit(1)
})
