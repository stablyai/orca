import { describe, expect, it, vi } from 'vitest'
import type { BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import { openBotItemWorker } from './bot-item-worker-open'

const worker: BotChatTreeWorker = {
  key: 'd-old',
  title: 'Fix the snapshot test',
  state: 'done',
  startedAt: 1,
  dispatchId: 'd-old'
}

const results: Record<string, unknown> = {
  'orchestration.partyOpen': { location: { kind: 'terminal', handle: 'term-7' } },
  'terminal.focus': { focus: { worktreeId: 'wt-9' } },
  'session.tabs.list': {
    tabs: [{ type: 'terminal', id: 'tab-3', terminal: 'term-7', leafId: 'leaf-1' }]
  }
}

function recordingClient(replies: Record<string, unknown>) {
  const sent: { method: string; params: unknown }[] = []
  const client = stubRpcClient({
    sendRequest: (method, params) => {
      sent.push({ method, params })
      return Promise.resolve({ id: method, ok: true, result: replies[method] ?? {} })
    }
  })
  return { client, sent }
}

const chatWorker: BotChatTreeWorker = {
  key: 'worker:d-chat',
  title: 'Review the PR',
  state: 'running',
  startedAt: 1,
  worktreeId: 'wt-bot',
  dispatchId: 'd-chat'
}

describe('openBotItemWorker', () => {
  it("opens a chat worker's chat where the host finds its Dispatch, not the workspace", async () => {
    const { client, sent } = recordingClient({
      'orchestration.partyOpen': {
        location: { kind: 'chat', sessionId: 'sess-2', worktreeId: 'wt-bot' }
      },
      'session.tabs.list': {
        tabs: [{ type: 'agent-session', id: 'tab-chat', sessionId: 'sess-2', agent: 'claude' }]
      }
    })
    const open = vi.fn()
    openBotItemWorker(chatWorker, {
      client,
      loaded: [chatWorker],
      open,
      current: () => true,
      showToast: () => {}
    })
    await vi.waitFor(() => expect(open).toHaveBeenCalled())
    expect(sent[0]).toEqual({
      method: 'orchestration.partyOpen',
      params: { address: 'dispatch:d-chat' }
    })
    expect(open).toHaveBeenCalledWith({
      ...chatWorker,
      worktreeId: 'wt-bot',
      paneKey: 'tab-chat:2b8ea975-8113-41ae-a25c-feb50cbe084a'
    })
  })

  it('opens a terminal worker at its pane without asking the host', () => {
    const { client, sent } = recordingClient({})
    const open = vi.fn()
    const terminal = { ...chatWorker, paneKey: 'tab-1:leaf-1' }
    openBotItemWorker(terminal, {
      client,
      loaded: [],
      open,
      current: () => true,
      showToast: () => {}
    })
    expect(open).toHaveBeenCalledWith(terminal)
    expect(sent).toEqual([])
  })

  it('tells the owner a lost chat worker is gone instead of opening the workspace', async () => {
    const { client } = recordingClient({
      'orchestration.partyOpen': { location: null, lost: 'chat' }
    })
    const open = vi.fn()
    const showToast = vi.fn()
    openBotItemWorker(chatWorker, {
      client,
      loaded: [chatWorker],
      open,
      current: () => true,
      showToast
    })
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled())
    expect(open).not.toHaveBeenCalled()
  })

  it('opens a worker the chats tree has not loaded where the host finds its Dispatch', async () => {
    const sent: { method: string; params: unknown }[] = []
    const client = stubRpcClient({
      sendRequest: (method, params) => {
        sent.push({ method, params })
        return Promise.resolve({ id: method, ok: true, result: results[method] })
      }
    })
    const open = vi.fn()
    openBotItemWorker(worker, {
      client,
      loaded: [],
      open,
      current: () => true,
      showToast: () => {}
    })
    await vi.waitFor(() => expect(open).toHaveBeenCalled())
    expect(sent[0]).toEqual({
      method: 'orchestration.partyOpen',
      params: { address: 'dispatch:d-old' }
    })
    expect(open).toHaveBeenCalledWith({ ...worker, worktreeId: 'wt-9', paneKey: 'tab-3:leaf-1' })
  })
})
