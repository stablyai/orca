import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

// Documents an accepted compatibility limit, not a fix: installed phones keep their shipped
// paging arithmetic, so a host that returns fewer rows than requested exhausts it early.

const TRANSCRIPT_ROWS = 3000

type PageRequest = { limit: number; beforeOffset: number }

function row(index: number): NativeChatMessage {
  return {
    id: `row-${index}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: `row ${index}` }],
    timestamp: 1,
    source: 'transcript',
    transcriptOffset: index
  }
}

/** A host that answers each requested page with at most `rowsPerReply` rows (a byte bound). */
function boundedHost(rowsPerReply: number) {
  return ({ limit, beforeOffset }: PageRequest) => {
    const count = Math.min(limit, rowsPerReply, beforeOffset)
    const start = beforeOffset - count
    return {
      messages: Array.from({ length: count }, (_, index) => row(start + index)),
      hasMore: start > 0,
      beforeOffset: start
    }
  }
}

/** The shipped phone's cursor paging: it advances by the requested count, not the rows received. */
function shippedPhonePaging(host: ReturnType<typeof boundedHost>) {
  let limit = 40
  let beforeOffset = TRANSCRIPT_ROWS - 40
  let retained = 40
  let hasMore = true
  const requests: PageRequest[] = []
  while (hasMore) {
    const nextLimit = Math.min(limit + 60, 2000)
    const pageLimit = nextLimit - limit
    if (pageLimit <= 0) {
      break
    }
    requests.push({ limit: pageLimit, beforeOffset })
    const result = host({ limit: pageLimit, beforeOffset })
    limit = nextLimit
    beforeOffset = result.beforeOffset
    retained += result.messages.length
    hasMore = nextLimit < 2000 && result.hasMore
  }
  return { requests, retained, hostHadMore: beforeOffset > 0 }
}

let renderer: ReactTestRenderer | null = null
let chat: MobileNativeChatSession | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  chat = null
})

function Harness({ client }: { client: RpcClient }): null {
  chat = useMobileNativeChatSession({
    client,
    sourceIdentity: 'host\0workspace',
    agent: 'claude',
    sessionId: 'session',
    transcriptPath: null
  })
  return null
}

async function updatedPhonePaging(host: ReturnType<typeof boundedHost>) {
  const requests: PageRequest[] = []
  const sendRequest = vi.fn(async (_method: string, params: unknown) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook sends a cursor page once the snapshot carries offsets.
    const request = params as PageRequest
    requests.push({ limit: request.limit, beforeOffset: request.beforeOffset })
    return { ok: true, result: host(request) }
  })
  const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
    onData({
      type: 'snapshot',
      messages: Array.from({ length: 40 }, (_, index) => row(TRANSCRIPT_ROWS - 40 + index)),
      hasMore: true,
      beforeOffset: TRANSCRIPT_ROWS - 40
    })
    return () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reaches only subscribe and sendRequest.
  const client = { sendRequest, subscribe } as unknown as RpcClient
  await act(async () => {
    renderer = create(createElement(Harness, { client }))
  })
  // Bounded so a paging regression fails instead of spinning.
  for (let read = 0; chat?.hasMore && read < 500; read += 1) {
    await act(async () => {
      chat?.loadEarlier()
      await Promise.resolve()
    })
  }
  return { requests, retained: chat?.messages.length ?? 0 }
}

describe('old phones against byte-bounded host pages', () => {
  it('stops a shipped phone after 33 reads when requested pages exceed the content budget', () => {
    const shipped = shippedPhonePaging(boundedHost(10))

    expect(shipped.requests).toHaveLength(33)
    expect(shipped.retained).toBe(40 + 33 * 10)
    expect(shipped.hostHadMore).toBe(true)
  })

  it('leaves normal-sized pages exactly as a shipped phone pages them today', async () => {
    const shipped = shippedPhonePaging(boundedHost(60))
    const updated = await updatedPhonePaging(boundedHost(60))

    expect(updated.requests).toEqual(shipped.requests)
    expect(updated.retained).toBe(shipped.retained)
    expect(updated.retained).toBe(2000)
  })

  it('lets an updated phone page bounded replies up to the retention ceiling', async () => {
    const updated = await updatedPhonePaging(boundedHost(10))

    expect(updated.retained).toBe(2000)
    expect(updated.requests.length).toBeGreaterThan(33)
  })
})
