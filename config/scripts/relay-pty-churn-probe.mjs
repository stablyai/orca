// HOW TO RUN: copy this file, relay-gc-host.cjs, the built `relay.js` and its `.version` into one
// directory on the target host (they resolve each other via import.meta.dirname), install a
// matching `node-pty` beside them, then `node <this file>`. Results are exact counts and
// post-collection heap figures; nothing here asserts on a duration.
// Real-host churn probe with PTYs attached, plus forced-GC retained-heap readings.
// Every reported number is an exact count or a post-collection heap figure; no wall-clock bounds.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { readFileSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const VERSION = readFileSync(join(HERE, '.version'), 'utf8').trim()
const RUNDIR = '/tmp/orca-pty-churn-probe'
const SOCK = join(RUNDIR, 'relay.sock')
const GC_REPORT = join(RUNDIR, 'gc.json')
const HEADER = 13
const CYCLES = 3
const CONNS_PER_CYCLE = 20

rmSync(RUNDIR, { recursive: true, force: true })
mkdirSync(RUNDIR, { recursive: true })

function encodeFrame(type, id, ack, payload) {
  const h = Buffer.alloc(HEADER)
  h[0] = type
  h.writeUInt32BE(id, 1)
  h.writeUInt32BE(ack, 5)
  h.writeUInt32BE(payload.length, 9)
  return Buffer.concat([h, payload])
}
const handshakeFrame = () =>
  encodeFrame(
    2,
    0,
    0,
    Buffer.from(JSON.stringify({ type: 'orca-relay-handshake', version: VERSION }))
  )

function decodeFrames(buf) {
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
    let done = false
    sock.on('error', (e) => !done && reject(e))
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      const { frames, rest } = decodeFrames(buf)
      buf = rest
      for (const f of frames) {
        if (f.type !== 2) {
          continue
        }
        const msg = JSON.parse(f.payload.toString())
        done = true
        if (msg.type === 'orca-relay-handshake-ok') {
          sock.removeAllListeners('data')
          sock._carry = buf
          sock._seq = 0
          resolve(sock)
        } else {
          reject(new Error(`handshake refused: ${msg.type}`))
        }
      }
    })
    sock.on('connect', () => sock.write(handshakeFrame()))
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
      const { frames, rest } = decodeFrames(buf)
      buf = rest
      for (const f of frames) {
        if (f.type !== 1) {
          continue
        }
        let msg
        try {
          msg = JSON.parse(f.payload.toString())
        } catch {
          continue
        }
        if (msg.id === id) {
          clearTimeout(timer)
          sock.off('data', onData)
          sock._carry = buf
          if (msg.error) {
            reject(new Error(JSON.stringify(msg.error)))
          } else {
            resolve(msg.result)
          }
        }
      }
    }
    sock.on('data', onData)
    sock.write(
      encodeFrame(
        1,
        ++sock._seq,
        0,
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      )
    )
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fdCount = (pid) => {
  try {
    return readdirSync(`/proc/${pid}/fd`).length
  } catch {
    return -1
  }
}

async function forcedGcMem(pid) {
  try {
    writeFileSync(GC_REPORT, '')
  } catch {
    /* ignore */
  }
  process.kill(pid, 'SIGUSR2')
  for (let i = 0; i < 60; i++) {
    await sleep(100)
    try {
      const raw = readFileSync(GC_REPORT, 'utf8')
      if (raw.trim()) {
        return JSON.parse(raw).mem
      }
    } catch {
      /* not written yet */
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
  const relayLog = []
  child.stderr.on('data', (d) => relayLog.push(d.toString()))
  child.stdout.on('data', (d) => relayLog.push(d.toString()))

  for (let i = 0; i < 150 && !existsSync(SOCK); i++) {
    await sleep(100)
  }
  if (!existsSync(SOCK)) {
    throw new Error('relay socket never appeared')
  }
  await sleep(500)

  const pid = child.pid
  const obs = await connect()
  const rows = []
  const snap = async (label) => {
    const s = await rpc(obs, 'relay.status', {})
    const mem = await forcedGcMem(pid)
    rows.push({
      label,
      clients: s.socket.clients,
      accepted: s.socket.acceptedConnections,
      ptys: s.ptys.active,
      fds: fdCount(pid),
      heapAfterGcMb: mem ? +(mem.heapUsed / 1048576).toFixed(2) : null,
      rssMb: mem ? +(mem.rss / 1048576).toFixed(1) : null,
      externalMb: mem ? +(mem.external / 1048576).toFixed(2) : null,
      session: JSON.stringify(s.ptySourceCredit.session)
    })
  }

  await snap('baseline (observer only)')

  const ptyIds = []
  let spawnError = null
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const socks = []
    for (let i = 0; i < CONNS_PER_CYCLE; i++) {
      const s = await connect()
      socks.push(s)
      try {
        const r = await rpc(s, 'pty.spawn', {
          cwd: RUNDIR,
          cols: 80,
          rows: 24,
          shell: '/bin/sh',
          args: []
        })
        if (r?.id !== undefined) {
          ptyIds.push(r.id)
        }
      } catch (e) {
        spawnError ??= e.message
      }
    }
    await snap(`cycle ${cycle}: ${CONNS_PER_CYCLE} conns holding PTYs`)
    // Drop uncleanly -- no pty.shutdown, no socket end handshake.
    for (const s of socks) {
      s.destroy()
    }
    await sleep(1000)
    await snap(`cycle ${cycle}: conns dropped uncleanly`)
  }

  // PTYs are meant to SURVIVE a dropped connection; retire them explicitly and re-check.
  let shutdownError = null
  for (const id of ptyIds) {
    try {
      await rpc(obs, 'pty.shutdown', { id })
    } catch (e) {
      shutdownError ??= e.message
    }
  }
  await sleep(1500)
  await snap('after explicit pty.shutdown of every PTY')

  console.log(JSON.stringify({ spawnError, shutdownError, ptysSpawned: ptyIds.length }, null, 1))
  console.log(JSON.stringify(rows, null, 1))

  // --- reaper: a client that speaks once (keepalive) then goes silent ---
  const beforeB = (await rpc(obs, 'relay.status', {})).socket.clients
  const talker = await connect()
  talker.write(encodeFrame(9, 1, 0, Buffer.alloc(0))) // KeepAlive => keepaliveObserved = true
  await sleep(2000)
  const duringB = (await rpc(obs, 'relay.status', {})).socket.clients
  await sleep(32000) // TIMEOUT_MS is 20s; give the 5s keepalive tick room to judge it
  const afterB = (await rpc(obs, 'relay.status', {})).socket.clients
  console.log(
    JSON.stringify({ reaperStoppedAnswering: { beforeB, duringB, afterB, fds: fdCount(pid) } })
  )
  talker.destroy()

  // --- reaper: a client that completes the handshake and never frames anything ---
  await sleep(1000)
  const beforeA = (await rpc(obs, 'relay.status', {})).socket.clients
  const mute = await connect()
  await sleep(2000)
  const duringA = (await rpc(obs, 'relay.status', {})).socket.clients
  await sleep(132000) // SILENT_CONNECT_TIMEOUT_MS = TIMEOUT_MS * 6 = 120s
  const afterA = (await rpc(obs, 'relay.status', {})).socket.clients
  console.log(JSON.stringify({ reaperNeverSpoke: { beforeA, duringA, afterA, fds: fdCount(pid) } }))
  mute.destroy()

  const finalMem = await forcedGcMem(pid)
  console.log(
    JSON.stringify({
      finalHeapAfterGcMb: finalMem ? +(finalMem.heapUsed / 1048576).toFixed(2) : null,
      finalRssMb: finalMem ? +(finalMem.rss / 1048576).toFixed(1) : null,
      finalFds: fdCount(pid)
    })
  )

  const log = relayLog.join('')
  console.log(
    JSON.stringify({
      logStoppedAnswering: (log.match(/stopped answering/g) || []).length,
      logNeverSpoke: (log.match(/never spoke/g) || []).length
    })
  )

  obs.destroy()
  child.kill('SIGKILL')
  await sleep(500)
  console.log(`RELAY_PID=${pid}`)
}

main().catch(async (e) => {
  console.error(`PROBE_FAILED: ${e.message}`)
  process.exit(1)
})
