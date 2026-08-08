// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JiraIssueTitleInput } from './JiraIssueWorkspace'

function dispatchKey(
  input: HTMLInputElement,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit
): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => input.dispatchEvent(event))
  return event.defaultPrevented
}

function renderTitle(onSubmit: (value: string) => void): HTMLInputElement {
  const view = render(
    <JiraIssueTitleInput value="테스" onChange={() => {}} onSubmit={onSubmit} disabled={false} />
  )
  return view.getByRole('textbox') as HTMLInputElement
}

function dispatchRecordedGesture(input: HTMLInputElement): boolean {
  act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  dispatchKey(input, 'keydown', {
    key: 'Process',
    code: 'Enter',
    keyCode: 229,
    isComposing: true
  })
  act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  const prevented = dispatchKey(input, 'keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    isComposing: false
  })
  dispatchKey(input, 'keyup', { key: 'Process', keyCode: 229 })
  dispatchKey(input, 'keyup', { key: 'Enter', keyCode: 13 })
  return prevented
}

afterEach(cleanup)

describe('JiraIssueTitleInput IME Enter ownership', () => {
  it('does not update Jira on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn()
    const input = renderTitle(onSubmit)

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('updates Jira exactly once on ordinary Enter', () => {
    const onSubmit = vi.fn()
    const input = renderTitle(onSubmit)

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('테스')
  })
})
