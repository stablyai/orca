import { describe, expect, it, vi } from 'vitest'
import { forkCodexThread, readRequiredCodexForkHistory } from './codex-thread-fork'

function turn(id: string) {
  return {
    id,
    status: 'completed',
    itemsView: 'full',
    items: [
      { type: 'userMessage', id: `u-${id}`, content: [{ type: 'text', text: `ask ${id}` }] },
      { type: 'agentMessage', id: `a-${id}`, text: `answer ${id}` }
    ]
  }
}

const input = { threadId: 'parent', lastTurnId: 'B', cwd: '/workspace', sessionId: 'child-chat' }

describe('Codex fork materialization', () => {
  it('forks through the completed turn before importing only provider history', async () => {
    const beforeFork = vi.fn(async () => {})
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'parent',
            model: 'parent-model',
            reasoningEffort: 'high',
            modelProvider: 'parent-provider'
          }
        }
      }
      if (method === 'thread/fork') {
        expect(beforeFork).toHaveBeenCalledOnce()
        expect(params).toMatchObject({
          threadId: 'parent',
          lastTurnId: 'B',
          excludeTurns: true,
          deferGoalContinuation: true,
          model: 'parent-model',
          modelProvider: 'parent-provider',
          config: { model_reasoning_effort: 'high' }
        })
        return { thread: { id: 'child' }, model: 'gpt-test', reasoningEffort: 'high' }
      }
      expect(params?.threadId).toBe('child')
      return { data: [turn('B'), turn('A')], nextCursor: null }
    })
    const fork = await forkCodexThread({ connection: { request }, ...input, beforeFork })
    expect(fork.providerHandle.nativeId).toBe('child')
    expect(
      fork.items.filter((item) => item.body.kind === 'message').map((item) => item.body)
    ).toEqual([
      expect.objectContaining({ role: 'user', blocks: [{ type: 'text', text: 'ask A' }] }),
      expect.objectContaining({ role: 'assistant', blocks: [{ type: 'text', text: 'answer A' }] }),
      expect.objectContaining({ role: 'user', blocks: [{ type: 'text', text: 'ask B' }] }),
      expect.objectContaining({ role: 'assistant', blocks: [{ type: 'text', text: 'answer B' }] })
    ])
    expect(fork.options).toMatchObject({ model: 'gpt-test', effort: 'high' })
  })

  it('imports compacted history under the child identity when branching a branch', async () => {
    const compacted = {
      id: 'compacted',
      status: 'completed',
      itemsView: 'full',
      items: [{ type: 'contextCompaction', id: 'compact' }]
    }
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/read') {
        return { thread: { id: 'first-child' } }
      }
      if (method === 'thread/fork') {
        expect(params?.threadId).toBe('first-child')
        expect(params?.lastTurnId).toBe('B')
        return { thread: { id: 'second-child' } }
      }
      return { data: [turn('B'), compacted, turn('A')], nextCursor: null }
    })
    const fork = await forkCodexThread({
      ...input,
      threadId: 'first-child',
      connection: { request },
      beforeFork: async () => {}
    })
    expect(
      fork.items.some(
        (item) => item.body.kind === 'status' && item.body.presentation === 'compaction'
      )
    ).toBe(true)
    expect(
      fork.items.filter((item) => item.identity.provider === 'codex').map((item) => item.identity)
    ).toEqual([
      expect.objectContaining({ threadId: 'second-child', turnId: 'A' }),
      expect.objectContaining({ threadId: 'second-child', turnId: 'A' }),
      expect.objectContaining({ threadId: 'second-child', turnId: 'B' }),
      expect.objectContaining({ threadId: 'second-child', turnId: 'B' })
    ])
  })

  it('does not accept a server ignoring the inclusive cut', async () => {
    await expect(
      readRequiredCodexForkHistory({
        ...input,
        threadId: 'child',
        connection: {
          request: async () => ({ data: [turn('C'), turn('B'), turn('A')], nextCursor: null })
        }
      })
    ).rejects.toThrow('cut')
  })

  it('rejects empty, partial and over-capacity histories instead of preparing a ready child', async () => {
    await expect(
      readRequiredCodexForkHistory({
        ...input,
        connection: { request: async () => ({ data: [], nextCursor: null }) }
      })
    ).rejects.toThrow('cut')
    const request = vi.fn(async () => ({ data: [turn('B')], nextCursor: 'older' }))
    request
      .mockImplementationOnce(async () => ({ data: [turn('B')], nextCursor: 'older' }))
      .mockRejectedValueOnce(new Error('page failed'))
    await expect(
      readRequiredCodexForkHistory({ ...input, connection: { request } })
    ).rejects.toThrow('page failed')
    await expect(
      readRequiredCodexForkHistory({
        ...input,
        connection: {
          request: async () => ({
            data: Array.from({ length: 1025 }, (_, i) => turn(String(i))),
            nextCursor: null
          })
        }
      })
    ).rejects.toThrow('too-large')
  })

  it('rejects same-thread replies without modifying the parent', async () => {
    const request = vi.fn(async () => ({ thread: { id: 'parent' } }))
    await expect(
      forkCodexThread({ connection: { request }, ...input, beforeFork: async () => {} })
    ).rejects.toThrow('independent')
    expect(request).toHaveBeenCalledTimes(2)
  })
})
