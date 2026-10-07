import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const RUNTIME = path.join(os.homedir(), 'Library/Application Support/orca/daemon')
const SOCK = path.join(RUNTIME, 'daemon-v36.sock')
const TOKEN = fs.readFileSync(path.join(RUNTIME, 'daemon-v36.token'), 'utf8').trim()
const VERSION = 36
const CLIENT_ID = 'sta7948-evidence-' + crypto.randomBytes(6).toString('hex')
const TARGET = process.argv[2]
const LABEL = process.argv[3] || 'probe'

function connect(role) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK)
    const lines = []
    let buf = ''
    const handlers = []
    s.setEncoding('utf8')
    s.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let msg; try { msg = JSON.parse(line) } catch { continue }
        lines.push(msg)
        for (const h of handlers) h(msg)
      }
    })
    s.on('error', reject)
    s.on('connect', () => {
      s.write(JSON.stringify({ type: 'hello', version: VERSION, token: TOKEN, clientId: CLIENT_ID, role }) + '\n')
      handlers.push(function onHello(m) {
        if (m.type === 'hello') resolve({ socket: s, hello: m, lines, handlers })
      })
    })
  })
}

const rpcWaiters = new Map()
function rpc(ctl, type, payload) {
  const id = 'req_' + crypto.randomBytes(6).toString('hex')
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('rpc timeout ' + type)), 20000)
    rpcWaiters.set(id, (m) => { clearTimeout(t); resolve(m) })
    ctl.socket.write(JSON.stringify({ id, type, payload }) + '\n')
  })
}

const ctl = await connect('control')
console.log('HELLO_CONTROL', JSON.stringify(ctl.hello))
ctl.handlers.push((m) => { if (m.id && rpcWaiters.has(m.id)) { const f = rpcWaiters.get(m.id); rpcWaiters.delete(m.id); f(m) } })

const stream = await connect('stream')
console.log('HELLO_STREAM', JSON.stringify(stream.hello))

const sessionId = 'sta7948-evidence-' + crypto.randomBytes(8).toString('hex')
let out = ''
let exited = null
stream.handlers.push((m) => {
  if (m.type !== 'event' || m.sessionId !== sessionId) return
  if (m.event === 'data') out += m.payload.data
  if (m.event === 'exit') exited = m.payload
  if (m.event === 'terminalError') console.log('TERMINAL_ERROR', JSON.stringify(m.payload))
})

const PY = `import os,sys\ntry:\n    n=sum(1 for _ in os.scandir(${JSON.stringify(TARGET)}))\n    print('ORCA_PROBE ok', n)\nexcept OSError as e:\n    print('ORCA_PROBE err', e.errno, e.strerror)\n`
const command = `/usr/bin/python3 ${JSON.stringify(path.join(process.env.HOME, "orca-lanes/sta-7948-evidence-20260921/scandir_probe.py"))} ${JSON.stringify(TARGET)}; exit`

const created = await rpc(ctl, 'createOrAttach', {
  sessionId, cols: 80, rows: 24, cwd: TARGET, command,
  startupCommandDelivery: 'shell-ready', shellReadySupported: true, shellReadyTimeoutMs: 8000,
  cancelAfterMs: 20000
})
console.log('CREATE_RESULT', JSON.stringify(created))

const deadline = Date.now() + 25000
while (Date.now() < deadline && !(out.includes('ORCA_MARKER_END') && exited)) {
  await new Promise((r) => setTimeout(r, 250))
}
console.log('EXIT_EVENT', JSON.stringify(exited))
console.log('--- OUTPUT BEGIN ---')
console.log(JSON.stringify(out.slice(-4000)))
console.log('--- OUTPUT END ---')
const probeLines = out.split(/\r?\n/).filter((l) => l.includes('ORCA_PROBE'))
console.log('PROBE_LINES', JSON.stringify(probeLines))

try { console.log('KILL', JSON.stringify(await rpc(ctl, 'kill', { sessionId }))) } catch (e) { console.log('KILL_ERR', String(e)) }
const list = await rpc(ctl, 'listSessions', {})
const mine = (list.payload?.sessions ?? []).filter((s) => s.sessionId === sessionId)
console.log('LIST_AFTER_KILL_MINE', JSON.stringify(mine))
console.log('LIST_TOTAL', (list.payload?.sessions ?? []).length)
ctl.socket.destroy(); stream.socket.destroy()
process.exit(0)
