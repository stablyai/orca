import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobilePromptSuggestion } from './use-mobile-prompt-suggestion'

let renderer: ReactTestRenderer
let result: ReturnType<typeof useMobilePromptSuggestion>
const onAccept = vi.fn()
let editGeneration = 0
const initial = () => ({
  scopeKey: 'host:tab:session',
  enabled: true,
  value: '',
  source: { text: 'Write tests' },
  onAccept,
  getEditGeneration: () => editGeneration
})
type Args = Parameters<typeof useMobilePromptSuggestion>[0]
function Harness(props: Args) {
  result = useMobilePromptSuggestion(props)
  return null
}
async function render(props: Args) {
  await act(async () => {
    renderer = create(createElement(Harness, props))
  })
}
async function update(props: Args) {
  await act(async () => renderer.update(createElement(Harness, props)))
}
afterEach(() => {
  act(() => renderer?.unmount())
  vi.useRealTimers()
  onAccept.mockClear()
  editGeneration = 0
})

it('fills only the draft and hides the accepted suggestion', async () => {
  await render(initial())
  expect(result.text).toBe('Write tests')
  await act(async () => result.accept())
  expect(onAccept).toHaveBeenCalledExactlyOnceWith('Write tests')
  expect(result.text).toBeNull()
})

it('hides while typing or blocked, restores after clearing, and remembers dismissal', async () => {
  await render(initial())
  await update({ ...initial(), value: 'My draft' })
  expect(result.text).toBeNull()
  await update(initial())
  expect(result.text).toBe('Write tests')
  await update({ ...initial(), enabled: false })
  expect(result.text).toBeNull()
  await update(initial())
  act(() => result.dismiss())
  await update({ ...initial(), value: 'temporary' })
  await update(initial())
  expect(result.text).toBeNull()
  await update({ ...initial(), source: { text: 'Review changes' } })
  expect(result.text).toBe('Review changes')
})

it('handles older hosts and isolates identical suggestions across sessions', async () => {
  await render({ ...initial(), source: {} })
  expect(result.text).toBeNull()
  await update(initial())
  act(() => result.dismiss())
  await update({ ...initial(), scopeKey: 'other-host:tab:session' })
  expect(result.text).toBe('Write tests')
  await update({ ...initial(), source: { text: null } })
  expect(result.text).toBeNull()
})

it('polls only when eligible and rechecks a terminal before accepting', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockResolvedValue('Write tests')
  const props = { ...initial(), source: { read } }
  await render(props)
  expect(result.text).toBe('Write tests')
  read.mockResolvedValue(null)
  await act(async () => result.accept())
  expect(onAccept).not.toHaveBeenCalled()
  await update({ ...props, enabled: false })
  const count = read.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000)
  })
  expect(read).toHaveBeenCalledTimes(count)
})

it.each(['session', 'draft', 'disconnect', 'edit-generation', 'focus', 'dismiss', 'unmount'])(
  'rejects a delayed acceptance after %s changes',
  async (change) => {
    let finish!: (text: string | null) => void
    const read = vi
      .fn()
      .mockResolvedValueOnce('Write tests')
      .mockImplementation(
        () =>
          new Promise<string | null>((resolve) => {
            finish = resolve
          })
      )
    let focusGeneration = 0
    const props = { ...initial(), source: { read }, getFocusGeneration: () => focusGeneration }
    await render(props)
    let accepting: Promise<void>
    act(() => {
      accepting = result.accept()
    })
    const finishAcceptance = finish
    if (change === 'session') {
      await update({ ...props, scopeKey: 'another-session' })
    }
    if (change === 'draft') {
      await update({ ...props, value: 'Keep my text' })
    }
    if (change === 'disconnect') {
      await update({ ...props, enabled: false })
    }
    if (change === 'edit-generation') {
      editGeneration += 1
    }
    if (change === 'focus') {
      focusGeneration += 1
    }
    if (change === 'dismiss') {
      act(() => result.dismiss())
    }
    if (change === 'unmount') {
      act(() => renderer.unmount())
    }
    await act(async () => {
      finishAcceptance('Write tests')
      await accepting
    })
    expect(onAccept).not.toHaveBeenCalled()
  }
)
