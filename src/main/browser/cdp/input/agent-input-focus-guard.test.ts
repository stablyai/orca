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
  AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL,
  guardPaneFocusForAgentInput
} from './agent-input-focus-guard'

function fakeRenderer(id: number, answer: boolean) {
  const sent: { channel: string; data: { token: string; active: boolean; holdFocus?: boolean } }[] =
    []
  const renderer = {
    id,
    isDestroyed: () => false,
    send: vi.fn(
      (channel: string, data: { token: string; active: boolean; holdFocus?: boolean }) => {
        sent.push({ channel, data })
        if (answer && data.active) {
          for (const listener of ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL) ?? []) {
            listener({ sender: { id } }, { token: data.token })
          }
        }
      }
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard only reads id, isDestroyed and send.
  return { sent, renderer: renderer as unknown as Electron.WebContents }
}

describe('guardPaneFocusForAgentInput', () => {
  beforeEach(() => {
    ipcListeners.clear()
    vi.useRealTimers()
  })

  it('lets the input through when a busy pane answers a second late', async () => {
    vi.useFakeTimers()
    const { sent, renderer } = fakeRenderer(7, false)

    const guarded = guardPaneFocusForAgentInput(renderer, 'page-1')
    await vi.advanceTimersByTimeAsync(1000)
    const [listener] = ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL) ?? []
    listener({ sender: { id: 7 } }, { token: sent[0].data.token })

    await expect(guarded).resolves.toBeTypeOf('function')
    expect(sent.map(({ data }) => data.active)).toEqual([true])
  })
  it('times out and closes the guard when only a different renderer answers', async () => {
    vi.useFakeTimers()
    const { sent, renderer } = fakeRenderer(7, false)

    const guarded = guardPaneFocusForAgentInput(renderer, 'page-1')
    const refusal = expect(guarded).rejects.toMatchObject({
      code: 'browser_focus_guard_unavailable',
      data: { phase: 'no_pane_answer' }
    })
    const [listener] = ipcListeners.get(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL) ?? []
    listener({ sender: { id: 8 } }, { token: sent[0].data.token })
    await vi.advanceTimersByTimeAsync(2000)

    await refusal
    expect(sent.map(({ data }) => data.active)).toEqual([true, false])
  })
  it('asks the pane only whether the user composes when focus need not be held', async () => {
    const { sent, renderer } = fakeRenderer(7, true)

    await expect(
      guardPaneFocusForAgentInput(renderer, 'page-1', { holdFocus: false })
    ).resolves.toBeTypeOf('function')
    expect(sent[0].data).toMatchObject({ active: true, holdFocus: false })
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
