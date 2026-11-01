import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcListeners } = vi.hoisted(() => ({
  ipcListeners: new Map<string, ((event: unknown, reply: unknown) => void)[]>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, listener: (event: unknown, reply: unknown) => void) => {
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener])
    }),
    removeListener: vi.fn((channel: string, listener: (event: unknown, reply: unknown) => void) => {
      ipcListeners.set(
        channel,
        (ipcListeners.get(channel) ?? []).filter((entry) => entry !== listener)
      )
    })
  }
}))

import {
  AGENT_INPUT_FOCUS_GUARD_CHANNEL,
  AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL,
  guardPaneFocusForAgentInput
} from './agent-input-focus-guard'

function fakeRenderer(id: number, answer: boolean) {
  const sent: { channel: string; data: { token: string; active: boolean } }[] = []
  const renderer = {
    id,
    isDestroyed: () => false,
    send: vi.fn((channel: string, data: { token: string; active: boolean }) => {
      sent.push({ channel, data })
      if (answer && data.active) {
        for (const listener of ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL) ?? []) {
          listener({ sender: { id } }, { token: data.token })
        }
      }
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard only reads id, isDestroyed and send.
  return { sent, renderer: renderer as unknown as Electron.WebContents }
}

describe('guardPaneFocusForAgentInput', () => {
  beforeEach(() => {
    ipcListeners.clear()
    vi.useRealTimers()
  })

  it('resolves when the pane is ready and ends the guard once', async () => {
    const { sent, renderer } = fakeRenderer(7, true)

    const release = await guardPaneFocusForAgentInput(renderer, 'page-1')
    release()
    release()

    expect(sent.map(({ channel, data }) => [channel, data.active])).toEqual([
      [AGENT_INPUT_FOCUS_GUARD_CHANNEL, true],
      [AGENT_INPUT_FOCUS_GUARD_CHANNEL, false]
    ])
    expect(sent[0].data.token).toBe(sent[1].data.token)
    expect(ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL)).toEqual([])
  })

  it('refuses the input and ends the guard when the pane never answers', async () => {
    vi.useFakeTimers()
    const { sent, renderer } = fakeRenderer(7, false)

    const guarded = guardPaneFocusForAgentInput(renderer, 'page-1')
    const outcome = expect(guarded).rejects.toMatchObject({
      code: 'browser_focus_guard_unavailable'
    })
    await vi.advanceTimersByTimeAsync(150)

    await outcome
    expect(sent.map(({ data }) => data.active)).toEqual([true, false])
    expect(ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL)).toEqual([])
  })

  it('ignores a ready reply from another renderer', async () => {
    vi.useFakeTimers()
    const { renderer } = fakeRenderer(7, false)
    let settled: 'pending' | 'ready' | 'refused' = 'pending'

    void guardPaneFocusForAgentInput(renderer, 'page-1').then(
      () => {
        settled = 'ready'
      },
      () => {
        settled = 'refused'
      }
    )
    const [listener] = ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL) ?? []
    const { calls } = vi.mocked(renderer.send).mock
    listener({ sender: { id: 8 } }, { token: calls[0][1].token })
    await Promise.resolve()

    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(150)
    expect(settled).toBe('refused')
  })
  it('refuses the input at once and ends the guard while the user composes', async () => {
    const { sent, renderer } = fakeRenderer(7, false)

    const guarded = guardPaneFocusForAgentInput(renderer, 'page-1')
    const [listener] = ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL) ?? []
    listener({ sender: { id: 7 } }, { token: sent[0].data.token, composing: true })

    await expect(guarded).rejects.toMatchObject({ code: 'browser_user_composing' })
    expect(sent.map(({ data }) => data.active)).toEqual([true, false])
    expect(ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL)).toEqual([])
  })
})
