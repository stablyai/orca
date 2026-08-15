import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'

describe('useMobileNativeChatAskDismiss', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatAskDismiss> | null = null
  let renders = 0

  beforeEach(() => {
    renders = 0
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({
    prompt,
    detectedPrompt = prompt,
    scopeKey = 'tab-1',
    sessionKey = 'session-1',
    observing = true
  }: {
    prompt: AskPrompt | null
    detectedPrompt?: AskPrompt | null
    scopeKey?: string | null
    sessionKey?: string | null
    observing?: boolean
  }): null {
    renders += 1
    state = useMobileNativeChatAskDismiss({
      ask: prompt,
      detectedAsk: detectedPrompt,
      scopeKey,
      sessionKey,
      observing
    })
    return null
  }

  async function mount(props: Parameters<typeof Harness>[0]): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, props))
    })
  }

  async function update(props: Parameters<typeof Harness>[0]): Promise<void> {
    await act(async () => renderer?.update(createElement(Harness, props)))
  }

  const first: AskPrompt = {
    questions: [
      { question: 'same first', multiSelect: false, options: [] },
      { question: 'old second', multiSelect: false, options: [] }
    ]
  }
  const replacement: AskPrompt = {
    questions: [
      { question: 'same first', multiSelect: false, options: [] },
      { question: 'new second', multiSelect: false, options: [] }
    ]
  }

  it('shows a structurally different replacement without an intervening null', async () => {
    await mount({ prompt: first })
    act(() => state?.dismissAsk())
    expect(state?.showAsk).toBe(false)

    await update({ prompt: replacement })
    expect(state?.showAsk).toBe(true)

    await update({ prompt: first })
    expect(state?.showAsk).toBe(true)
  })

  it('keeps a dismissal while status gating hides a still-detected prompt', async () => {
    await mount({ prompt: first })
    const acceptedDismiss = state!.dismissAsk

    await update({ prompt: null, detectedPrompt: first })
    act(() => acceptedDismiss())
    await update({ prompt: first })

    expect(state?.showAsk).toBe(false)
  })

  it('ignores an answer that settles after its prompt cleared', async () => {
    await mount({ prompt: first })
    const lateDismiss = state!.dismissAsk

    await update({ prompt: null })
    act(() => lateDismiss())
    await update({ prompt: first })

    expect(state?.showAsk).toBe(true)
  })

  it('keeps a dismissal taken on-chat across a chat→terminal→chat toggle', async () => {
    // The common case: answer the card, then toggle to the terminal. The prompt
    // derives to null while hidden, and that null must not retire the dismissal.
    await mount({ prompt: first })
    act(() => state?.dismissAsk())
    expect(state?.showAsk).toBe(false)

    await update({ prompt: null, observing: false })
    await update({ prompt: first, observing: true })

    expect(state?.showAsk).toBe(false)
  })

  it('keeps a dismissal across a chat→terminal→chat toggle', async () => {
    // While the chat surface is hidden the prompt derives to null; that null
    // proves nothing about the agent and must not reset the dismissal.
    await mount({ prompt: first })
    const acceptedDismiss = state!.dismissAsk

    await update({ prompt: null, observing: false })
    act(() => acceptedDismiss())
    await update({ prompt: first, observing: true })

    expect(state?.showAsk).toBe(false)
  })

  it('forgets the dismissal once the prompt clears while observable', async () => {
    await mount({ prompt: first })
    act(() => state?.dismissAsk())

    // Agent moved on: the prompt cleared with chat visible.
    await update({ prompt: null, observing: true })
    await update({ prompt: first, observing: true })

    expect(state?.showAsk).toBe(true)
  })

  it('scopes the dismissal to the tab that showed the card', async () => {
    await mount({ prompt: first, scopeKey: 'tab-1' })
    act(() => state?.dismissAsk())

    // The same question on another tab is a different pending prompt.
    await update({ prompt: first, scopeKey: 'tab-2' })
    expect(state?.showAsk).toBe(true)
    act(() => state?.dismissAsk())
    expect(state?.showAsk).toBe(false)

    // Dismissing tab 2 must not overwrite tab 1's dismissal.
    await update({ prompt: first, scopeKey: 'tab-1' })
    expect(state?.showAsk).toBe(false)

    await update({ prompt: first, scopeKey: 'tab-2' })
    expect(state?.showAsk).toBe(false)
  })

  it('shows an identical prompt after the tab starts a new provider session', async () => {
    await mount({ prompt: first, sessionKey: 'session-1' })
    act(() => state?.dismissAsk())

    await update({ prompt: first, sessionKey: 'session-2' })

    expect(state?.showAsk).toBe(true)
  })

  it('reports nothing to show without a prompt', async () => {
    await mount({ prompt: null })
    expect(state?.showAsk).toBe(false)
  })

  it('does not re-render a scope with nothing dismissed when the prompt changes', async () => {
    await mount({ prompt: first })
    const afterMount = renders

    await update({ prompt: replacement })

    // One render for the prop change and no more: the reset effect must hand back
    // the same Map when this scope has no dismissal, or every observed prompt
    // change commits a fresh one. The hook sits on the session route, so that
    // wasted commit re-renders the whole session surface.
    expect(renders).toBe(afterMount + 1)
  })

  it('records a settled answer against its originating tab', async () => {
    await mount({ prompt: first, scopeKey: 'tab-1' })
    const tabOneDismiss = state!.dismissAsk

    await update({ prompt: replacement, scopeKey: 'tab-2' })
    act(() => tabOneDismiss())
    await update({ prompt: first, scopeKey: 'tab-1' })

    expect(state?.showAsk).toBe(false)
  })
})
