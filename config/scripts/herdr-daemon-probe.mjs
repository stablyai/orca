#!/usr/bin/env node
// Why: inspect the in-app herdr daemon exactly as the app sees it — snapshot,
// per-pane visible reads (what the frame poller renders), and an input echo
// round trip. Run while Orca is open: node config/scripts/herdr-daemon-probe.mjs
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const socketPath =
  process.argv[2] ?? join(homedir(), '.local', 'share', 'orca', 'herdr-daemon.sock')
const socket = connect(socketPath)
let buffer = ''
let nextId = 1
const pending = new Map()

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})

socket.on('error', (error) => {
  console.error('probe: socket error:', error.message)
  process.exit(1)
})

function request(method, params) {
  const id = String(nextId++)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 8000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) {
        reject(new Error(`${method}: ${message.error.code} ${message.error.message}`))
      } else {
        resolve(message.result)
      }
    })
    socket.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

async function main() {
  const { snapshot } = await request('session.snapshot', {})
  console.log('== snapshot ==')
  console.log(
    'workspaces:',
    snapshot.workspaces.map(
      (w) => `${w.workspace_id}:${w.label}${w.tokens?.orca_binding ? ' [bound]' : ''}`
    )
  )
  console.log(
    'tabs:',
    snapshot.tabs.map((t) => `${t.tab_id}:${t.label} (ws ${t.workspace_id})`)
  )
  for (const pane of snapshot.panes) {
    console.log(
      `pane ${pane.pane_id}: ws=${pane.workspace_id} tab=${pane.tab_id} cwd=${pane.cwd} revision=${pane.revision} tokens=${pane.tokens ? Object.keys(pane.tokens).join(',') : '-'}`
    )
  }

  for (const pane of snapshot.panes) {
    const read = await request('pane.read', {
      pane_id: pane.pane_id,
      format: 'ansi',
      source: 'visible'
    })
    const text = read?.read?.text ?? ''
    console.log(
      `\n== pane ${pane.pane_id} visible read (revision ${read?.read?.revision}, ${text.length} chars) ==`
    )
    console.log(JSON.stringify(text.slice(-400)))
  }

  // echo round trip on the first local pane
  const target = snapshot.panes.find((pane) => !pane.connection_id)
  if (target) {
    await request('pane.send_text', { pane_id: target.pane_id, text: 'echo PROBE_ECHO\r' })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const read = await request('pane.read', {
      pane_id: target.pane_id,
      format: 'ansi',
      source: 'recent_unwrapped',
      lines: 50
    })
    console.log(
      `\n== echo on ${target.pane_id}: ${(read?.read?.text ?? '').includes('PROBE_ECHO') ? 'ECHO OK' : 'NO ECHO'} ==`
    )
    console.log(JSON.stringify((read?.read?.text ?? '').slice(-300)))
  }
  socket.end()
  process.exit(0)
}

main().catch((error) => {
  console.error('probe failed:', error)
  socket.end()
  process.exit(1)
})
