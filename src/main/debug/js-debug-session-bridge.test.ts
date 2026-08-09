import { createServer, connect as netConnect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { DebugAdapterEventMessage } from '../../shared/debug-session-types'
import { DapClient } from './dap-client'
import { DapMessageDecoder, encodeDapMessage } from './dap-message-framing'
import { DebugSessionStateMachine } from './debug-session-state-machine'
import { createJsDebugSessionBridge } from './js-debug-session-bridge'

/**
 * Simulates vscode-js-debug's cascaded session model: the first connection
 * ("parent") answers initialize/launch/configurationDone but never actually
 * runs anything, then fires a `startDebugging` reverse request; the second
 * connection ("child") is where breakpoints and execution really land.
 */
function startFakeJsDebugServer(): Promise<{
  server: Server
  port: number
  childSetBreakpointsCalls: unknown[]
  childRequests: string[]
}> {
  const childSetBreakpointsCalls: unknown[] = []
  const childRequests: string[] = []
  let connectionCount = 0

  const server = createServer((socket: Socket) => {
    connectionCount += 1
    const isParent = connectionCount === 1
    const decoder = new DapMessageDecoder()
    let seq = 1000 * connectionCount
    const send = (msg: unknown): void => {
      socket.write(encodeDapMessage(msg))
    }
    const respond = (
      request: { seq: number; command: string },
      body?: unknown,
      success = true
    ): void => {
      seq += 1
      send({
        seq,
        type: 'response',
        request_seq: request.seq,
        success,
        command: request.command,
        body
      })
    }

    decoder.on('message', (raw) => {
      const msg = raw as { seq: number; type: string; command: string; arguments?: unknown }
      if (msg.type !== 'request') {
        return
      }

      if (isParent) {
        if (msg.command === 'initialize') {
          respond(msg, { supportsConfigurationDoneRequest: true })
        } else if (msg.command === 'launch') {
          respond(msg, {})
          setTimeout(() => {
            seq += 1
            send({
              seq,
              type: 'request',
              command: 'startDebugging',
              arguments: {
                request: 'launch',
                configuration: { type: 'pwa-node', program: '/x.js' }
              }
            })
          }, 5)
        } else {
          respond(msg, {})
        }
        return
      }

      childRequests.push(msg.command)
      if (msg.command === 'setBreakpoints') {
        childSetBreakpointsCalls.push(msg.arguments)
        respond(msg, { breakpoints: [{ verified: true }] })
      } else if (msg.command === 'configurationDone') {
        respond(msg, {})
        setTimeout(() => {
          seq += 1
          send({
            seq,
            type: 'event',
            event: 'stopped',
            body: { reason: 'breakpoint', threadId: 1 }
          })
        }, 5)
      } else {
        respond(msg, {})
      }
    })

    socket.on('data', (chunk: Buffer) => decoder.push(chunk))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('server not listening')
      }
      resolve({ server, port: address.port, childSetBreakpointsCalls, childRequests })
    })
  })
}

describe('createJsDebugSessionBridge', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('cascades a startDebugging reverse request into a bridged child session', async () => {
    const fake = await startFakeJsDebugServer()
    server = fake.server

    const connect = (): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const socket = netConnect(fake.port, '127.0.0.1')
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      })

    const bridge = createJsDebugSessionBridge(connect)
    await bridge.ready

    const outerClient = new DapClient(bridge.stdin, bridge.stdout)
    const machine = new DebugSessionStateMachine(outerClient)

    const stopped = new Promise<DebugAdapterEventMessage>((resolve) => {
      machine.on('event', (msg: DebugAdapterEventMessage) => {
        if (msg.event === 'stopped') {
          resolve(msg)
        }
      })
    })

    await machine.initialize({ adapterID: 'node' })
    await machine.launch({ request: 'launch', args: { type: 'pwa-node', program: '/x.js' } })
    // Set during "configuring", before the child exists yet — the bridge
    // must cache and replay this onto the child once it's promoted.
    await machine.setBreakpoints({ source: { path: '/x.js' }, breakpoints: [{ line: 3 }] })
    await machine.configurationDone()

    const stoppedEvent = await stopped
    expect(stoppedEvent.body).toEqual({ reason: 'breakpoint', threadId: 1 })
    // setBreakpoints has DAP replace semantics, so it's fine (if a little
    // redundant) for both promoteChild()'s replay and the outer caller's own
    // still-in-flight setBreakpoints() to reach the child — every delivery
    // carries the identical, idempotent breakpoint set.
    for (const call of fake.childSetBreakpointsCalls) {
      expect(call).toEqual({ source: { path: '/x.js' }, breakpoints: [{ line: 3 }] })
    }
    expect(fake.childSetBreakpointsCalls.length).toBeGreaterThanOrEqual(1)
    // The child's own promotion handshake always runs in this exact order;
    // an extra setBreakpoints may trail it if the outer caller's own
    // still-in-flight call reaches the child right after (see above).
    expect(fake.childRequests.slice(0, 4)).toEqual([
      'initialize',
      'launch',
      'setBreakpoints',
      'configurationDone'
    ])

    // Live commands after promotion route to the child, not the parent.
    await machine.continue(1)
    expect(fake.childRequests).toContain('continue')

    bridge.kill()
  })
})
