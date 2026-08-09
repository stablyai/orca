import { PassThrough } from 'node:stream'
import type { Duplex, Readable, Writable } from 'node:stream'
import {
  DapClient,
  type DapEventMessage,
  type DapRequestMessage,
  type DapResponseMessage
} from './dap-client'
import { DapMessageDecoder, encodeDapMessage } from './dap-message-framing'

export type JsDebugSocketConnector = () => Promise<Duplex>

/**
 * How long a live-session command (setBreakpoints/continue/evaluate/...)
 * waits for the `startDebugging` cascade to at least begin before giving up
 * and falling back to the parent session. Real launches (confirmed against
 * the actual adapter) take well under this — Chrome's cold launch alone was
 * ~2s — this is a safety valve, not a normal-path delay. The parent doesn't
 * implement these commands and can hang rather than error on them (also
 * confirmed against the real Chrome adapter), so falling back immediately
 * when the cascade just hasn't started *yet* is worse than waiting.
 */
const CHILD_CASCADE_WAIT_TIMEOUT_MS = 15_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type JsDebugSessionBridge = {
  stdin: Writable
  stdout: Readable
  /** Resolves once the parent session's `initialize`/`launch`/... requests can be routed — await before handing `stdin`/`stdout` to a `DapClient`. */
  ready: Promise<void>
  kill: () => void
}

/**
 * A DAP request belongs to "the caller's own session" (the DAP spec's
 * phrasing for `startDebugging`) rather than to whatever child session is
 * currently bound to the actual debuggee.
 */
const PARENT_SESSION_COMMANDS = new Set(['initialize', 'launch', 'attach', 'configurationDone'])

/**
 * Bridges Phase 0's single-session spine (`DapClient` + `DebugSessionStateMachine`,
 * unmodified) to vscode-js-debug's cascaded session model. The socket you
 * connect first (the "parent") never runs the debuggee itself — per the DAP
 * spec, it sends a `startDebugging` reverse request asking the client to
 * open a *second* connection (the "child") "in the same way the caller's
 * session was started," and that child is where breakpoints actually bind
 * and execution actually stops.
 *
 * This runs the child's own initialize/launch/configurationDone handshake
 * internally — replaying any breakpoints the outer caller already set on the
 * parent, since VS Code-style flows set breakpoints during "configuring",
 * before a child can possibly exist yet — then transparently retargets
 * live-session requests from the outer `DapClient` to the child, merging
 * both sessions' events into one outer stream. The outer spine never knows
 * cascading happened.
 *
 * v1 scope: only the first `startDebugging` call is bridged (the common
 * "launch/attach one script" case). Later calls — worker threads, forked
 * children — are acknowledged so the adapter never stalls, but are not yet
 * surfaced as additional sessions.
 */
export function createJsDebugSessionBridge(connect: JsDebugSocketConnector): JsDebugSessionBridge {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const inboundDecoder = new DapMessageDecoder()
  let outSeq = 0
  let killed = false

  let parentClient: DapClient | null = null
  let childClient: DapClient | null = null
  let childPromotion: Promise<void> | null = null
  let resolveChildPromotionStarted: (() => void) | null = null
  const childPromotionStarted = new Promise<void>((resolve) => {
    resolveChildPromotionStarted = resolve
  })
  const breakpointsBySourcePath = new Map<string, Record<string, unknown>>()
  let exceptionBreakpointArgs: Record<string, unknown> | null = null

  function pushToOuter(message: unknown): void {
    if (killed) {
      return
    }
    stdout.write(encodeDapMessage(message))
  }

  function writeResponse(
    requestSeq: number,
    command: string,
    success: boolean,
    body?: unknown,
    message?: string
  ): void {
    outSeq += 1
    const response: DapResponseMessage = {
      seq: outSeq,
      type: 'response',
      request_seq: requestSeq,
      success,
      command,
      body,
      message
    }
    pushToOuter(response)
  }

  function forwardEvents(client: DapClient): void {
    client.on('event', (msg: DapEventMessage) => pushToOuter(msg))
  }

  async function promoteChild(startArgs: {
    request: 'launch' | 'attach'
    configuration: Record<string, unknown>
  }): Promise<void> {
    const socket = await connect()
    const client = new DapClient(socket, socket)
    forwardEvents(client)
    const adapterID =
      typeof startArgs.configuration.type === 'string' ? startArgs.configuration.type : 'pwa-node'
    await client.request('initialize', {
      adapterID,
      clientID: 'orca',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path'
    })
    // Same deferred-response pattern as the outer machine's own launch() —
    // the child adapter withholds this response until it sees the child's
    // own configurationDone, so awaiting it here would deadlock.
    const launchResponded = client.request(startArgs.request, startArgs.configuration)
    launchResponded.catch(() => undefined)
    for (const args of breakpointsBySourcePath.values()) {
      await client.request('setBreakpoints', args)
    }
    if (exceptionBreakpointArgs) {
      await client.request('setExceptionBreakpoints', exceptionBreakpointArgs)
    }
    await client.request('configurationDone')
    await launchResponded
    childClient = client
  }

  async function resolveLiveTarget(): Promise<DapClient> {
    if (!childPromotion) {
      await Promise.race([childPromotionStarted, delay(CHILD_CASCADE_WAIT_TIMEOUT_MS)])
    }
    if (childPromotion) {
      await childPromotion
    }
    return childClient ?? parentClient!
  }

  async function routeRequest(msg: DapRequestMessage): Promise<void> {
    const args = (msg.arguments ?? {}) as Record<string, unknown>
    if (msg.command === 'setBreakpoints') {
      const sourcePath = (args.source as { path?: string } | undefined)?.path
      if (sourcePath) {
        breakpointsBySourcePath.set(sourcePath, args)
      }
    } else if (msg.command === 'setExceptionBreakpoints') {
      exceptionBreakpointArgs = args
    }

    const target = PARENT_SESSION_COMMANDS.has(msg.command)
      ? parentClient!
      : await resolveLiveTarget()

    try {
      const body = await target.request(msg.command, msg.arguments)
      writeResponse(msg.seq, msg.command, true, body)
    } catch (err) {
      writeResponse(
        msg.seq,
        msg.command,
        false,
        undefined,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  inboundDecoder.on('message', (msg) => {
    const request = msg as DapRequestMessage
    if (request.type === 'request') {
      void routeRequest(request)
    }
  })
  stdin.on('data', (chunk: Buffer) => inboundDecoder.push(chunk))

  const ready = connect().then((parentSocket) => {
    parentClient = new DapClient(parentSocket, parentSocket)
    forwardEvents(parentClient)
    parentClient.on('reverseRequest', (msg: DapRequestMessage, respond) => {
      // Ack unconditionally first: startDebugging's response carries no
      // body, and the adapter should not block on our (possibly slow)
      // child handshake to consider the request handled.
      respond(undefined, true)
      if (msg.command !== 'startDebugging' || childPromotion) {
        return
      }
      const startArgs = msg.arguments as {
        request: 'launch' | 'attach'
        configuration: Record<string, unknown>
      }
      childPromotion = promoteChild(startArgs).catch((err) => {
        pushToOuter({
          seq: 0,
          type: 'event',
          event: 'output',
          body: {
            category: 'stderr',
            output: `Failed to start js-debug child session: ${err instanceof Error ? err.message : String(err)}\n`
          }
        })
      })
      resolveChildPromotionStarted?.()
      resolveChildPromotionStarted = null
    })
  })

  return {
    stdin,
    stdout,
    ready,
    kill: () => {
      killed = true
      parentClient?.close()
      childClient?.close()
    }
  }
}
