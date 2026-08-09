import { describe, expect, it } from 'vitest'
import type { DebugAdapterEventMessage } from '../../shared/debug-session-types'
import { DapClient } from './dap-client'
import { LocalDebugAdapterProcessHost } from './debug-adapter-process-host'
import { DebugSessionStateMachine } from './debug-session-state-machine'

/**
 * Bare-bones DAP server, framed exactly like a real adapter, run as a
 * standalone `node -e` child process — no mocks anywhere in this test.
 * Proves the spine (framing + DapClient + state machine + process host)
 * actually works end to end without depending on Wave 1's real
 * `vscode-js-debug` integration.
 */
const FAKE_ADAPTER_SCRIPT = `
let buffer = Buffer.alloc(0)
let seq = 0
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n')
  process.stdout.write(body)
}
function handle(msg) {
  if (msg.command === 'initialize') {
    send({ seq: ++seq, type: 'response', request_seq: msg.seq, success: true, command: 'initialize', body: { supportsConfigurationDoneRequest: true } })
  } else if (msg.command === 'launch') {
    send({ seq: ++seq, type: 'response', request_seq: msg.seq, success: true, command: 'launch' })
  } else if (msg.command === 'configurationDone') {
    send({ seq: ++seq, type: 'response', request_seq: msg.seq, success: true, command: 'configurationDone' })
    setTimeout(() => {
      send({ seq: ++seq, type: 'event', event: 'stopped', body: { reason: 'entry', threadId: 1 } })
    }, 10)
  } else if (msg.command === 'disconnect') {
    send({ seq: ++seq, type: 'response', request_seq: msg.seq, success: true, command: 'disconnect' })
  } else {
    send({ seq: ++seq, type: 'response', request_seq: msg.seq, success: true, command: msg.command })
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /Content-Length: (\\d+)/.exec(header)
    if (!match) return
    const length = Number(match[1])
    if (buffer.length < headerEnd + 4 + length) return
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length)
    buffer = buffer.subarray(headerEnd + 4 + length)
    handle(JSON.parse(body.toString('utf8')))
  }
})
`

describe('DAP spine end-to-end smoke test', () => {
  it('drives a real (fake) adapter process through the full session lifecycle', async () => {
    const host = new LocalDebugAdapterProcessHost()
    const proc = await host.spawn({
      type: 'node',
      request: 'launch',
      command: process.execPath,
      args: ['-e', FAKE_ADAPTER_SCRIPT]
    })
    const client = new DapClient(proc.stdin, proc.stdout, proc.stderr)
    const machine = new DebugSessionStateMachine(client)

    const stateHistory: string[] = [machine.state]
    machine.on('stateChanged', (state: string) => stateHistory.push(state))

    const stoppedEvent = new Promise<DebugAdapterEventMessage>((resolve) => {
      machine.on('event', (msg: DebugAdapterEventMessage) => {
        if (msg.event === 'stopped') {
          resolve(msg)
        }
      })
    })

    try {
      const capabilities = await machine.initialize({ adapterID: 'node' })
      expect(capabilities).toEqual({ supportsConfigurationDoneRequest: true })

      await machine.launch({ request: 'launch', args: {} })
      await machine.configurationDone()
      expect(machine.state).toBe('running')

      const stopped = await stoppedEvent
      expect(stopped.body).toEqual({ reason: 'entry', threadId: 1 })
      expect(machine.state).toBe('paused')

      await machine.terminate()
      expect(machine.state).toBe('terminated')

      expect(stateHistory).toEqual([
        'initializing',
        'launching',
        'configuring',
        'running',
        'paused',
        'terminating',
        'terminated'
      ])
    } finally {
      proc.kill()
    }
  })
})
