import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  net: { fetch: fetchMock }
}))

import { submitFeedback } from './feedback'
import { FEEDBACK_API_URL, postFeedback, type FeedbackSubmitBody } from './feedback-request'

const plainSubmission: Parameters<typeof submitFeedback>[0] = {
  feedback: 'request ownership regression',
  submitAnonymously: true,
  githubLogin: null,
  githubEmail: null
}

const imageSubmission: Parameters<typeof submitFeedback>[0] = {
  ...plainSubmission,
  images: [{ contentType: 'image/png', data: new Uint8Array([1, 2, 3]) }]
}

function requestSignal(index = 0): AbortSignal {
  const signal = fetchMock.mock.calls[index]?.[1]?.signal
  if (!signal) {
    throw new Error('Expected an owned feedback request signal')
  }
  return signal
}

describe('feedback request ownership', () => {
  beforeEach(() => fetchMock.mockReset())

  it('retires an unread response after successful text submission', async () => {
    fetchMock.mockResolvedValue(new Response('unused response'))

    await expect(submitFeedback(plainSubmission)).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestSignal().aborted).toBe(true)
  })

  it('retires both failed text attempts while preserving the retry result', async () => {
    fetchMock.mockResolvedValue(new Response('unused error', { status: 503 }))

    await expect(submitFeedback(plainSubmission)).resolves.toEqual({
      ok: false,
      status: 503,
      error: 'status 503; retry: status 503'
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestSignal(0).aborted).toBe(true)
    expect(requestSignal(1).aborted).toBe(true)
  })

  it('retires a rejected image response without replaying the attachments', async () => {
    fetchMock.mockResolvedValue(new Response('unused error', { status: 503 }))

    await expect(submitFeedback(imageSubmission)).resolves.toEqual({
      ok: false,
      status: 503,
      error: 'status 503'
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestSignal().aborted).toBe(true)
  })

  it('keeps the request live until the image response reader finishes', async () => {
    const reading = Promise.withResolvers<void>()
    let finishResponse = (): void => {
      throw new Error('Response stream has not started')
    }
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"imagesDelivered":'))
          finishResponse = () => {
            controller.enqueue(new TextEncoder().encode('true}'))
            controller.close()
          }
        },
        pull() {
          reading.resolve()
        }
      })
    )
    fetchMock.mockResolvedValue(response)

    const submission = submitFeedback(imageSubmission)
    await reading.promise
    expect(requestSignal().aborted).toBe(false)
    finishResponse()

    await expect(submission).resolves.toEqual({ ok: true, imagesDelivered: true })
    expect(requestSignal().aborted).toBe(true)
  })

  it('retires diagnostic and report-only requests after an attachment fallback', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unused error', { status: 413 }))
      .mockResolvedValueOnce(new Response('unused response'))

    await expect(
      submitFeedback({
        ...plainSubmission,
        submissionType: 'crash',
        feedbackWithoutDiagnosticBundle: 'report without diagnostics',
        diagnosticBundle: {
          bundleSubmissionId: 'ownership-regression',
          content: '{"type":"bundle-header"}\n',
          bytes: 25,
          spanCount: 1
        }
      })
    ).resolves.toEqual({
      ok: true,
      diagnosticBundleFailure: { status: 413, error: 'status 413' }
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestSignal(0).aborted).toBe(true)
    expect(requestSignal(1).aborted).toBe(true)
  })

  it('retires failed network attempts without turning them into deadline errors', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('first network failure'))
      .mockRejectedValueOnce(new Error('retry network failure'))

    await expect(submitFeedback(plainSubmission)).resolves.toEqual({
      ok: false,
      status: null,
      error: 'first network failure; retry: retry network failure'
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestSignal(0).aborted).toBe(true)
    expect(requestSignal(1).aborted).toBe(true)
  })

  it('preserves the response reader error when retiring its request', async () => {
    fetchMock.mockResolvedValue(new Response('unused response'))
    const body: FeedbackSubmitBody = {
      feedback: plainSubmission.feedback,
      submissionType: 'feedback',
      githubLogin: null,
      githubEmail: null,
      appVersion: 'test',
      platform: process.platform,
      osRelease: 'test',
      arch: process.arch
    }
    const failure = new Error('response reader failure')

    await expect(
      postFeedback(FEEDBACK_API_URL, body, undefined, async () => {
        throw failure
      })
    ).rejects.toBe(failure)

    expect(requestSignal().aborted).toBe(true)
  })
})
