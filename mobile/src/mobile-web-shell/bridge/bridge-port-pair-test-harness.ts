import { createBridgeHost, type BridgeHost, type BridgeHostDiagnostic } from '../bridge-host'
import { createFakeRpcClient, type FakeRpcClient } from '../bridge-host-test-fakes'
import {
  readBridgeClientMessage,
  readBridgeHostMessage,
  type BridgeClientMessage,
  type BridgeHostMessage
} from './bridge-envelope'
import {
  createBridgeRpcClient,
  type BridgeRpcClient,
  type BridgeRpcClientDiagnostic
} from './bridge-rpc-client'

/**
 * The page and the shell wired to each other through the weakest transport that is still a
 * transport, so a test of either one is a test of the pair.
 *
 * Two properties are the whole point. One FIFO per direction, because a `subscribe` that overtook a
 * `sendRequest` would move the recorder's shared ordinal, which is what `write-ordinal.ts` exists to
 * catch. And delivery on a microtask, the weakest async the golden runner's zero-time drains flush
 * and the only one that moves no virtual millisecond.
 */
export type BridgePortPair = {
  client: BridgeRpcClient
  host: BridgeHost
  rpc: FakeRpcClient
  /** Everything each side posted, in the order it was posted, raw. */
  toShell: string[]
  toPage: string[]
  diagnostics: BridgeRpcClientDiagnostic[]
  hostDiagnostics: BridgeHostDiagnostic[]
  /** Runs both lanes until a full round moves nothing. */
  flush: () => Promise<void>
  /** Read back through the reader on the receiving side, so a frame this returns is one that lands. */
  readToShell: () => BridgeClientMessage[]
  readToPage: () => BridgeHostMessage[]
}

export type BridgePortPairOptions = {
  rpc?: FakeRpcClient
  sessionId?: string
  buildId?: string
}

type Lane = {
  sent: string[]
  push: (json: string) => void
  readonly depth: number
}

function createLane(deliver: (json: string) => void): Lane {
  const sent: string[] = []
  const queue: string[] = []
  let scheduled = false
  function drain(): void {
    scheduled = false
    const next = queue.shift()
    if (next === undefined) {
      return
    }
    deliver(next)
    schedule()
  }
  function schedule(): void {
    if (scheduled || queue.length === 0) {
      return
    }
    scheduled = true
    void Promise.resolve().then(drain)
  }
  return {
    sent,
    push(json: string): void {
      sent.push(json)
      queue.push(json)
      schedule()
    },
    get depth(): number {
      return queue.length
    }
  }
}

function readAll<TMessage>(
  frames: readonly string[],
  read: (json: string) => { ok: true; message: TMessage } | { ok: false; refusal: string }
): TMessage[] {
  return frames.map((json) => {
    const parsed = read(json)
    if (!parsed.ok) {
      throw new Error(`the other side would have refused this frame: ${parsed.refusal}`)
    }
    return parsed.message
  })
}

export function createBridgePortPair(options: BridgePortPairOptions = {}): BridgePortPair {
  const rpc = options.rpc ?? createFakeRpcClient()
  const diagnostics: BridgeRpcClientDiagnostic[] = []
  const hostDiagnostics: BridgeHostDiagnostic[] = []
  let receiveOnPage: ((json: string) => void) | null = null

  const toPage = createLane((json) => {
    receiveOnPage?.(json)
  })
  const host = createBridgeHost({
    client: rpc,
    post: (json) => {
      toPage.push(json)
      return Promise.resolve()
    },
    buildId: options.buildId ?? 'build-a',
    sessionId: options.sessionId ?? 'session-a',
    onDiagnostic: (diagnostic) => hostDiagnostics.push(diagnostic)
  })
  const toShell = createLane((json) => {
    host.receive(json)
  })
  const client = createBridgeRpcClient({
    send: (json) => {
      toShell.push(json)
    },
    onMessage: (handler) => {
      receiveOnPage = handler
      return () => {
        receiveOnPage = null
      }
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })

  return {
    client,
    host,
    rpc,
    toShell: toShell.sent,
    toPage: toPage.sent,
    diagnostics,
    hostDiagnostics,
    async flush(): Promise<void> {
      for (let round = 0; round < 64; round += 1) {
        const moved = toShell.sent.length + toPage.sent.length
        for (let turn = 0; turn < 8; turn += 1) {
          await Promise.resolve()
        }
        const quiet =
          toShell.depth === 0 &&
          toPage.depth === 0 &&
          moved === toShell.sent.length + toPage.sent.length
        if (quiet) {
          return
        }
      }
      throw new Error('the port pair never went quiet')
    },
    readToShell: () => readAll(toShell.sent, readBridgeClientMessage),
    readToPage: () => readAll(toPage.sent, readBridgeHostMessage)
  }
}
