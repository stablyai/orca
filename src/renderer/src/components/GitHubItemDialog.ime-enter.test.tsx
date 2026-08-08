// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('monaco-editor', () => ({}))
vi.mock('@/lib/monaco-setup', () => ({ monaco: {} }))
vi.mock('@monaco-editor/react', () => ({ default: () => null, DiffEditor: () => null }))

import { PRReviewersPanel } from './GitHubItemDialog'
import type { GitHubWorkItem } from '../../../shared/types'

const requestPRReviewers = vi.fn(async () => ({ ok: true as const, reviewRequests: [] }))

beforeEach(() => {
  requestPRReviewers.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    gh: {
      requestPRReviewers,
      listAssignableUsers: vi.fn(async () => [])
    }
  }
})

afterEach(cleanup)

function dispatchKey(el: HTMLElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => {
    el.dispatchEvent(event)
  })
}

const item = {
  id: 'pr-1',
  repoId: 'repo-1',
  number: 7,
  title: 'PR',
  itemType: 'PULL_REQUEST',
  reviewRequests: []
} as unknown as GitHubWorkItem

async function openReviewerInput(): Promise<HTMLInputElement> {
  render(
    <PRReviewersPanel item={item} loading={false} repoPath="/repo" onReviewersRequested={vi.fn()} />
  )
  const trigger = document.querySelector('button[aria-label="Reviewer"]') as HTMLButtonElement
  fireEvent.click(trigger)
  return await waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="Type or choose a user"]'
    )
    if (!input) {
      throw new Error('reviewer input not open')
    }
    return input
  })
}

// Why: this input requests a PR review remotely, which cannot be undone from the client, so the
// confirming Enter of a CJK composition must not reach the request path.
describe('GitHubItemDialog reviewer IME Enter ownership', () => {
  it('does not request a review on the recorded Korean Enter redispatch', async () => {
    const input = await openReviewerInput()
    fireEvent.change(input, { target: { value: '테스' } })

    fireEvent.compositionStart(input)
    dispatchKey(input, 'keydown', { key: 'Process', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(input, { data: '가' })
    dispatchKey(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })
    dispatchKey(input, 'keyup', { key: 'Process', keyCode: 229 })
    dispatchKey(input, 'keyup', { key: 'Enter', keyCode: 13 })

    expect(requestPRReviewers).not.toHaveBeenCalled()
  })

  // Discriminates in the other direction: the guard must not swallow a real review request.
  it('requests a review on an ordinary Enter', async () => {
    const input = await openReviewerInput()
    fireEvent.change(input, { target: { value: 'octocat' } })

    dispatchKey(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })

    await waitFor(() => expect(requestPRReviewers).toHaveBeenCalled())
  })
})
