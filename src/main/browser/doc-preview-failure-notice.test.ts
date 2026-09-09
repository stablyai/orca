import { afterEach, describe, expect, it, vi } from 'vitest'

import { DOC_PREVIEW_LOAD_FAILURE_CHANNEL } from '../../shared/doc-preview-scheme'
import { publishDocPreviewFailure, setDocPreviewFailureSink } from './doc-preview-failure-notice'

afterEach(() => {
  setDocPreviewFailureSink(null)
})

describe('publishDocPreviewFailure', () => {
  it('sends the grant, path, and reason on the failure channel', () => {
    const send = vi.fn()
    setDocPreviewFailureSink({ send })

    publishDocPreviewFailure({
      grantId: 'a'.repeat(32),
      relativePath: 'index.html',
      reason: 'too-large'
    })

    expect(send).toHaveBeenCalledWith(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, {
      grantId: 'a'.repeat(32),
      relativePath: 'index.html',
      reason: 'too-large'
    })
  })

  // Why: reads can outlive the window that asked for them; a missing sink must not throw inside
  // the protocol handler.
  it('is a no-op with no sink registered', () => {
    expect(() =>
      publishDocPreviewFailure({
        grantId: 'b'.repeat(32),
        relativePath: 'index.html',
        reason: 'unreadable'
      })
    ).not.toThrow()
  })

  it('sends nothing into a destroyed window', () => {
    const send = vi.fn()
    setDocPreviewFailureSink({ send, isDestroyed: () => true })

    publishDocPreviewFailure({
      grantId: 'c'.repeat(32),
      relativePath: 'index.html',
      reason: 'unreadable'
    })

    expect(send).not.toHaveBeenCalled()
  })

  // Why: a WebContents can be torn down between the liveness check and the send.
  it('swallows a throwing sink and stops using it', () => {
    const send = vi.fn(() => {
      throw new Error('Object has been destroyed')
    })
    setDocPreviewFailureSink({ send })
    const failure = {
      grantId: 'd'.repeat(32),
      relativePath: 'index.html',
      reason: 'unreadable' as const
    }

    expect(() => publishDocPreviewFailure(failure)).not.toThrow()
    publishDocPreviewFailure(failure)

    expect(send).toHaveBeenCalledTimes(1)
  })
})
