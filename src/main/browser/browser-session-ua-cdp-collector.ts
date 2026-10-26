import WebSocket from 'ws'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'

export type BrowserSessionUaCdpRequest = Readonly<{
  targetType: string
  resourceType: string
  url: string
  userAgent: string | null
  clientHints: Readonly<Record<string, string>>
}>

type PendingRequest = {
  targetType: string
  resourceType?: string
  url?: string
  headers?: Record<string, string>
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const record = readRecord(value)
  if (!record) {
    return undefined
  }
  const strings: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') {
      strings[key] = entry
    }
  }
  return strings
}

type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
  sessionId?: string
}

export class BrowserSessionUaCdpCollector {
  readonly diagnostics: string[] = []
  private readonly pendingCommands = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly targetsBySessionId = new Map<string, string>()
  private readonly requests = new Map<string, PendingRequest[]>()
  private readonly webSockets = new Map<string, PendingRequest>()
  private nextCommandId = 1

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse is untyped; CdpMessage is all-optional, so every member is still guarded before use in handleMessage.
      this.handleMessage(JSON.parse(data.toString()) as CdpMessage)
    )
  }

  static async connect(port: number): Promise<BrowserSessionUaCdpCollector> {
    const version = readRecord(
      await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json())
    )
    const webSocketDebuggerUrl = readString(version, 'webSocketDebuggerUrl')
    if (!webSocketDebuggerUrl) {
      throw new Error('cdp_version_missing_websocket_debugger_url')
    }
    const socket = new WebSocket(webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return new BrowserSessionUaCdpCollector(socket)
  }

  async installAutoAttach(): Promise<void> {
    await this.send('Target.setDiscoverTargets', { discover: true })
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    })
  }

  snapshot(): BrowserSessionUaCdpRequest[] {
    const result: BrowserSessionUaCdpRequest[] = []
    const requests = [...this.requests.values()].flat()
    for (const request of [...requests, ...this.webSockets.values()]) {
      if (!request.url || !request.headers) {
        continue
      }
      const normalizedHeaders = Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), String(value)])
      )
      result.push({
        targetType: request.targetType,
        resourceType: request.resourceType ?? 'Other',
        url: request.url,
        userAgent: normalizedHeaders['user-agent'] ?? null,
        clientHints: Object.fromEntries(
          Object.entries(normalizedHeaders).filter(([key]) => key.startsWith('sec-ch-ua'))
        )
      })
    }
    return result
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return
    }
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    const id = this.nextCommandId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject })
    })
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return promise
  }

  private handleMessage(message: CdpMessage): void {
    if (this.diagnostics.length < 50 && message.method) {
      this.diagnostics.push(`event:${message.method}:${message.sessionId ?? 'root'}`)
    }
    if (message.id !== undefined) {
      const pending = this.pendingCommands.get(message.id)
      if (!pending) {
        return
      }
      this.pendingCommands.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'CDP command failed'))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method === 'Target.targetCreated') {
      const targetInfo = readRecord(message.params)?.targetInfo
      const info = readRecord(targetInfo)
      const targetType = readString(info, 'type') ?? 'unknown'
      const targetId = readString(info, 'targetId') ?? 'unknown'
      const targetUrl = readString(info, 'url') ?? ''
      this.diagnostics.push(`target-created:${targetType}:${targetId}:${targetUrl}`)
    }
    if (message.method === 'Target.attachedToTarget') {
      const params = readRecord(message.params)
      const attachedSessionId = readString(params, 'sessionId')
      if (attachedSessionId) {
        const targetInfo = readRecord(params?.targetInfo)
        const targetType = readString(targetInfo, 'type') ?? 'unknown'
        const targetId = readString(targetInfo, 'targetId') ?? 'unknown'
        const targetUrl = readString(targetInfo, 'url') ?? ''
        this.diagnostics.push(
          // Record paused state to diagnose nested targets that fetch before capture starts.
          `attached:${targetType}:${targetId}:${targetUrl}:${attachedSessionId}:wfd=${String(params?.waitingForDebugger)}`
        )
        this.targetsBySessionId.set(attachedSessionId, targetType)
        void this.prepareTarget(attachedSessionId)
      }
      return
    }
    const sessionId = message.sessionId ?? 'browser'
    const params = message.params ?? {}
    if (message.method === 'Runtime.exceptionThrown') {
      this.diagnostics.push(`exception:${JSON.stringify(params)}`)
      return
    }
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined
    if (!requestId) {
      return
    }
    const key = `${sessionId}:${requestId}`
    if (message.method === 'Network.requestWillBeSent') {
      const request = readRecord(params.request)
      const hops = this.requests.get(key) ?? []
      const pending = hops.find((candidate) => candidate.url === undefined)
      const hop = pending ?? this.createPending(sessionId)
      if (!pending) {
        hops.push(hop)
      }
      hop.url = readString(request, 'url')
      hop.resourceType = typeof params.type === 'string' ? params.type : 'Other'
      this.requests.set(key, hops)
    } else if (message.method === 'Network.requestWillBeSentExtraInfo') {
      const hops = this.requests.get(key) ?? []
      const pending = hops.find((candidate) => candidate.headers === undefined)
      const hop = pending ?? this.createPending(sessionId)
      if (!pending) {
        hops.push(hop)
      }
      hop.headers = readStringRecord(params.headers) ?? {}
      this.requests.set(key, hops)
    } else if (message.method === 'Network.webSocketCreated') {
      const pending = this.webSockets.get(key) ?? this.createPending(sessionId)
      pending.url = typeof params.url === 'string' ? params.url : undefined
      pending.resourceType = 'WebSocket'
      this.webSockets.set(key, pending)
    } else if (message.method === 'Network.webSocketWillSendHandshakeRequest') {
      const pending = this.webSockets.get(key) ?? this.createPending(sessionId)
      pending.headers = readStringRecord(readRecord(params.request)?.headers) ?? {}
      this.webSockets.set(key, pending)
    }
  }

  private createPending(sessionId: string): PendingRequest {
    return { targetType: this.targetsBySessionId.get(sessionId) ?? 'unknown' }
  }

  private async prepareTarget(sessionId: string): Promise<void> {
    // Arm nested-target auto-attach before resuming parents so early requests are captured.
    const autoAttach = this.send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        // Exclude browser-level targets already attached by the root session.
        filter: [{ type: 'iframe' }, { type: 'worker' }]
      },
      sessionId
    )
    // Paused Electron targets acknowledge queued domain enables only after Runtime resumes them.
    const network = this.send('Network.enable', {}, sessionId)
    const runtime = this.send('Runtime.enable', {}, sessionId)
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch((error: unknown) => {
      this.diagnostics.push(`resume-error:${sessionId}:${String(error)}`)
    })
    const enabled = await Promise.allSettled([autoAttach, network, runtime])
    this.diagnostics.push(
      `enabled:${sessionId}:${enabled.map((result) => result.status).join(',')}`
    )
    this.diagnostics.push(`resumed:${sessionId}`)
  }
}

export async function waitForBrowserCdpEndpoint(port: number): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/version`)
      // Cancel the unused body to avoid Electron crashes (orca#8695).
      await cancelUnreadResponseBody(targets)
      if (targets.ok) {
        return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('browser_cdp_endpoint_timeout')
}
