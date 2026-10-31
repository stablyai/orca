import type { BridgeQueuedObservation, BridgeFixturePost } from './bridge-port-pair-contract'
import type { BridgeNativeVerb } from './bridge-native-verbs'

type Lane = {
  sent: string[]
  posts: BridgeFixturePost[]
  push: (json: string) => void
  drainNow: () => number
  readonly depth: number
}

export function createLane(
  deliver: (json: string) => void,
  capture?: (json: string) => BridgeQueuedObservation
): Lane {
  const sent: string[] = []
  const posts: BridgeFixturePost[] = []
  const queue: { json: string; observation?: BridgeQueuedObservation }[] = []
  function receive(item: (typeof queue)[number]): void {
    if (item.observation) {
      item.observation.runDelivery(() => deliver(item.json))
    } else {
      deliver(item.json)
    }
  }
  let scheduled = false
  function drain(): void {
    scheduled = false
    const next = queue.shift()
    if (next === undefined) {
      return
    }
    receive(next)
    schedule()
  }
  function schedule(): void {
    if (scheduled || queue.length === 0) {
      return
    }
    scheduled = true
    void Promise.resolve().then(drain)
  }
  function enqueue(json: string, observation?: BridgeQueuedObservation): void {
    queue.push({ json, observation })
    observation?.enqueued()
    schedule()
  }
  return {
    sent,
    posts,
    push(json: string): void {
      const observation = capture?.(json)
      sent.push(json)
      const post: BridgeFixturePost = {
        json,
        receiveAgain: (receipt) => {
          const witnessed = observation?.captureReceipt?.(receipt)
          if (capture && !witnessed) {
            throw new Error('Fixture receipt has no explicit observation owner')
          }
          sent.push(receipt)
          enqueue(receipt, witnessed)
        }
      }
      posts.push(post)
      enqueue(json, observation)
    },
    drainNow(): number {
      let moved = 0
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        receive(next)
        moved += 1
      }
      return moved
    },
    get depth(): number {
      return queue.length
    }
  }
}

export function readAll<TMessage>(
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

// Keep a valid default reply per verb table row so unconfigured native calls do not fail as malformed shell results.
export function defaultVerbAnswer(verb: BridgeNativeVerb): unknown {
  switch (verb) {
    case 'native.clipboard.write':
      return { written: true }
    case 'native.clipboard.read':
      return { value: 'pasteboard' }
    case 'native.media.pick':
      return { items: [] }
    case 'native.media.read':
      return { base64: '', eof: true }
    case 'native.media.release':
      return { released: false }
    case 'native.media.name':
      return { name: null }
    case 'native.audio.start':
      return { started: true, sampleRate: 16_000, permission: 'granted' }
    case 'native.audio.read':
      return { base64: '', droppedBytes: 0, recording: true, interruption: null }
    case 'native.audio.stop':
      return { stopped: true, base64: '', droppedBytes: 0 }
  }
}

export function neutralObservation(): BridgeQueuedObservation {
  return {
    enqueued: () => {},
    runDelivery: (receive) => receive(),
    captureReceipt: () => neutralObservation()
  }
}
