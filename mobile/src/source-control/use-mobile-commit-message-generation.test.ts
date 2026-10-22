import { createElement, startTransition, Suspense, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileGenerateCommitMessageResult } from './mobile-commit-message-ai'

vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
const reply = vi.hoisted(() => {
  const held: {
    resolve: ((result: MobileGenerateCommitMessageResult) => void) | null
    reject: ((error: Error) => void) | null
    cancel: () => Promise<void>
  } = { resolve: null, reject: null, cancel: async () => {} }
  return held
})
vi.mock('./mobile-commit-message-ai', () => ({
  requestMobileCommitMessage: () =>
    new Promise<MobileGenerateCommitMessageResult>((resolve, reject) => {
      reply.resolve = resolve
      reply.reject = reject
    }),
  cancelMobileCommitMessage: () => reply.cancel()
}))

import { useMobileCommitMessageGeneration } from './use-mobile-commit-message-generation'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked request module never reaches the client.
const client = {} as RpcClient
const view: {
  generating: boolean
  message: string
  error: string | null
  type: ((next: string) => void) | null
  generate: (() => Promise<void>) | null
  cancel: (() => void) | null
} = { generating: false, message: '', error: null, type: null, generate: null, cancel: null }

const suspended = new Promise<void>(() => {})
const suspendedRender = vi.fn()

function Harness({
  worktreeId = 'wt-1',
  suspend
}: {
  worktreeId?: string
  suspend?: boolean
}): null {
  const [message, setMessage] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const busyActionRef = useRef<string | null>(null)
  const { generateCommitMessage, cancelGenerateCommitMessage } = useMobileCommitMessageGeneration({
    client,
    worktreeId,
    generatingMessage: generating,
    mountedRef,
    busyActionRef,
    setGeneratingMessage: setGenerating,
    setCommitMessage: setMessage,
    setActionError: setError
  })
  if (suspend) {
    suspendedRender()
    throw suspended
  }
  view.generating = generating
  view.message = message
  view.error = error
  view.cancel = cancelGenerateCommitMessage
  view.type = setMessage
  view.generate = generateCommitMessage
  return null
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  reply.resolve = null
  reply.reject = null
  reply.cancel = async () => {}
})

async function generateThen(typed: string | null): Promise<void> {
  act(() => {
    renderer = create(createElement(Harness))
  })
  let pending: Promise<void> | undefined
  act(() => {
    pending = view.generate?.()
  })
  if (typed !== null) {
    act(() => view.type?.(typed))
  }
  await act(async () => {
    reply.resolve?.({ success: true, message: 'feat: generated' })
    await pending
  })
}

describe('useMobileCommitMessageGeneration', () => {
  it('keeps what the user typed while the agent ran, as desktop does', async () => {
    await generateThen('fix: my own words')
    expect(view.message).toBe('fix: my own words')
  })

  it('fills an empty box with the generated message', async () => {
    await generateThen(null)
    expect(view.message).toBe('feat: generated')
  })

  it.each(['success', 'failure'])(
    'does not publish the previous workspace generation %s into the new workspace',
    async (outcome) => {
      act(() => {
        renderer = create(createElement(Harness))
      })
      let oldPending: Promise<void> | undefined
      act(() => {
        oldPending = view.generate?.()
      })
      const settleOld = reply.resolve
      act(() => renderer?.update(createElement(Harness, { worktreeId: 'wt-2' })))
      expect(view.generating).toBe(false)
      let newPending: Promise<void> | undefined
      act(() => {
        newPending = view.generate?.()
      })
      const settleNew = reply.resolve
      await act(async () => {
        settleOld?.(
          outcome === 'success'
            ? { success: true, message: 'old workspace' }
            : { success: false, canceled: false, error: 'old error' }
        )
        await oldPending
      })
      expect(view.message).toBe('')
      expect(view.error).toBeNull()
      expect(view.generating).toBe(true)
      await act(async () => {
        settleNew?.({ success: true, message: 'new workspace' })
        await newPending
      })
      expect(view.message).toBe('new workspace')
      expect(view.generating).toBe(false)
    }
  )

  it('admits only one generation before React has rendered the loading state', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    let settleFirst: typeof reply.resolve = null
    act(() => {
      first = view.generate?.()
      settleFirst = reply.resolve
      second = view.generate?.()
    })
    expect(reply.resolve).toBe(settleFirst)
    await act(async () => {
      reply.resolve?.({ success: true, message: 'one generation' })
      await Promise.all([first, second])
    })
    expect(view.message).toBe('one generation')
  })

  it('keeps the current generation when a workspace transition suspends before commit', async () => {
    const render = (suspend?: boolean) =>
      createElement(
        Suspense,
        { fallback: null },
        createElement(Harness, {
          worktreeId: suspend ? 'wt-2' : 'wt-1',
          suspend
        })
      )
    act(() => {
      renderer = create(render())
    })
    let pending: Promise<void> | undefined
    act(() => {
      pending = view.generate?.()
    })
    suspendedRender.mockClear()
    act(() => {
      startTransition(() => renderer?.update(render(true)))
    })
    expect(suspendedRender).toHaveBeenCalled()
    expect(view.generating).toBe(true)
    await act(async () => {
      reply.resolve?.({ success: true, message: 'current workspace' })
      await pending
    })
    expect(view.message).toBe('current workspace')
    expect(view.generating).toBe(false)
  })

  it('shows no error from a run that was stopped and then failed', async () => {
    reply.cancel = () => Promise.reject(new Error('transport closed'))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    act(() => {
      renderer = create(createElement(Harness))
    })
    let pending: Promise<void> | undefined
    act(() => {
      pending = view.generate?.()
    })
    act(() => view.cancel?.())
    await act(async () => {
      reply.reject?.(new Error('transport closed'))
      await pending
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    process.off('unhandledRejection', unhandled)
    expect(view.error).toBeNull()
    expect(unhandled).not.toHaveBeenCalled()
  })
})
