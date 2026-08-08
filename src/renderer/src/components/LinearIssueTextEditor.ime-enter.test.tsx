// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearUpdateIssue: vi.fn(async () => ({ ok: true }))
}))

import { LinearIssueTextEditor } from './LinearIssueTextEditor'
import { useAppStore } from '@/store'
import type { LinearIssue } from '../../../shared/types'

const initialState = useAppStore.getInitialState()
let root: Root | null = null
let container: HTMLDivElement | null = null

function dispatchKey(el: HTMLElement, init: KeyboardEventInit): void {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => {
    el.dispatchEvent(event)
  })
}

function setValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set as (
    this: HTMLTextAreaElement,
    v: string
  ) => void
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function renderFocusedTitle(): Promise<HTMLTextAreaElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <LinearIssueTextEditor
        issue={
          {
            id: 'iss-1',
            identifier: 'ORC-1',
            title: 'old',
            description: ''
          } as unknown as LinearIssue
        }
        onIssueChange={() => {}}
        fields="title"
      />
    )
  })
  const textarea = container.querySelector('textarea')
  if (!textarea) {
    throw new Error('title textarea not found')
  }
  // The title commits by blurring, and blur is inert on a never-focused element here.
  act(() => textarea.focus())
  return textarea
}

describe('LinearIssueTextEditor title IME Enter ownership', () => {
  beforeEach(() => useAppStore.setState(initialState, true))
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  // Regression: the carry token owned any Enter carrying a modifier, so a user holding
  // Ctrl/Cmd through the composition confirm lost the title commit outright.
  // Ctrl, not Cmd: happy-dom's UA has no 'Mac', so getShortcutPlatform() reports linux.
  it('still commits when the modifier is held through the confirm redispatch', async () => {
    const textarea = await renderFocusedTitle()
    expect(document.activeElement).toBe(textarea)
    setValue(textarea, '테스트')

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    dispatchKey(textarea, { key: 'Enter', keyCode: 13, isComposing: true, ctrlKey: true })
    act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    dispatchKey(textarea, { key: 'Enter', keyCode: 13, isComposing: false, ctrlKey: true })

    expect(document.activeElement).not.toBe(textarea)
  })

  // Mode B: the bare Enter the IME redispatches after the confirm must stay swallowed.
  it('does not commit on the bare redispatch after a confirm', async () => {
    const textarea = await renderFocusedTitle()
    setValue(textarea, '테스트')

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    dispatchKey(textarea, { key: 'Process', keyCode: 229, isComposing: true })
    act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    dispatchKey(textarea, { key: 'Enter', keyCode: 13, isComposing: false })

    expect(document.activeElement).toBe(textarea)
  })

  // A chord pressed mid-composition is the IME's confirm, never a commit.
  it('does not commit on a chord pressed during composition', async () => {
    const textarea = await renderFocusedTitle()
    setValue(textarea, '테스트')

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    dispatchKey(textarea, { key: 'Enter', keyCode: 13, isComposing: true, ctrlKey: true })

    expect(document.activeElement).toBe(textarea)
  })

  it('commits on an ordinary Enter', async () => {
    const textarea = await renderFocusedTitle()
    setValue(textarea, 'plain title')

    dispatchKey(textarea, { key: 'Enter', keyCode: 13, isComposing: false })

    expect(document.activeElement).not.toBe(textarea)
  })
})
