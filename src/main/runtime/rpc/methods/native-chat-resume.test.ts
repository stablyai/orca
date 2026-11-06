import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { NativeChatSession } from '../../../../shared/rpc-contract/native-chat-params'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import type { RpcContext } from '../core'
import { NATIVE_CHAT_METHODS } from './native-chat'

type SnapshotFrame = {
  type: string
  resumed?: boolean
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number
}

function claudeLine(uuid: string, text = uuid): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })}\n`
}

describe('nativeChat.subscribe resumeAfter on a real transcript file', () => {
  let root = ''
  let file = ''
  const registry = new RuntimeSubscriptionRegistry()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-native-chat-resume-'))
    file = join(root, 'session.jsonl')
    await writeFile(file, ['a', 'b', 'c'].map((id) => claudeLine(id)).join(''))
  })

  afterEach(async () => {
    registry.cleanupByPrefix('nativeChat:')
    await rm(root, { recursive: true, force: true })
  })

  async function firstSnapshot(
    extra: { resumeAfter?: unknown; limit?: number } = {}
  ): Promise<SnapshotFrame> {
    const method = NATIVE_CHAT_METHODS.find(({ name }) => name === 'nativeChat.subscribe')
    const emitted: SnapshotFrame[] = []
    const context: RpcContext = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only touches these registry-backed members and the hook rows.
      runtime: {
        getAgentProviderSessionRows: () => [],
        registerSubscriptionCleanup: registry.register.bind(registry),
        cleanupSubscription: registry.cleanup.bind(registry)
      } as unknown as RpcContext['runtime'],
      connectionId: `phone-${Math.random()}`,
      clientKind: 'mobile'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method takes (params, ctx, emit); the test only calls it with that shape.
    await (method!.handler as (p: unknown, c: RpcContext, e: (v: never) => void) => Promise<void>)(
      method!.params!.parse({
        agent: 'claude',
        sessionId: 'session',
        transcriptPath: file,
        capabilities: { transcriptSourceOrder: 1 },
        ...extra
      }),
      context,
      (frame: never) => emitted.push(frame)
    )
    await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(0))
    return emitted[0]
  }

  function resumePoint(row: NativeChatMessage): unknown {
    return { id: row.id, transcriptOrder: row.transcriptOrder, timestamp: row.timestamp }
  }

  function ids(frame: SnapshotFrame): string[] {
    return frame.messages.map(({ id }) => id)
  }

  it('sends only the held row when nothing changed, and the rows after it when the file grew', async () => {
    const full = await firstSnapshot()
    expect(ids(full)).toEqual(['a', 'b', 'c'])
    const held = full.messages.at(-1)!

    const unchanged = await firstSnapshot({ resumeAfter: resumePoint(held) })
    expect(ids(unchanged)).toEqual(['c'])
    expect(unchanged).toMatchObject({
      resumed: true,
      hasMore: true,
      beforeOffset: held.transcriptOrder
    })

    await appendFile(file, claudeLine('d'))
    expect(ids(await firstSnapshot({ resumeAfter: resumePoint(held) }))).toEqual(['c', 'd'])
  })

  it('falls back to the full tail when the held row is gone, moved or out of the window', async () => {
    const held = (await firstSnapshot()).messages.at(-1)!
    const resumeAfter = resumePoint(held)

    const fullTail = async (limit?: number): Promise<string[]> => {
      const frame = await firstSnapshot({ resumeAfter, ...(limit ? { limit } : {}) })
      expect(frame.resumed).toBeUndefined()
      return ids(frame)
    }

    await writeFile(file, claudeLine('a') + claudeLine('b'))
    expect(await fullTail()).toEqual(['a', 'b'])

    await writeFile(file, claudeLine('x', 'longer first row') + claudeLine('c'))
    expect(await fullTail()).toEqual(['x', 'c'])

    await writeFile(file, ['a', 'b', 'c', 'd', 'e'].map((id) => claudeLine(id)).join(''))
    expect(await fullTail(2)).toEqual(['d', 'e'])
  })

  it('reads an unusable resume point as none instead of failing the subscribe', () => {
    const parsed = NativeChatSession.parse({
      agent: 'claude',
      sessionId: 'session',
      resumeAfter: { id: 'c', transcriptOrder: 'not-a-number' }
    })
    expect(parsed.resumeAfter).toBeUndefined()
  })
})
