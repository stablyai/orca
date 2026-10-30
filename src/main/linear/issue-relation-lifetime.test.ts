import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acquire, release } from './linear-request-concurrency'
import { linearError } from './issue-context/errors'
import { runLinearWriteAction } from '../runtime/runtime-linear-write-action'
import { writeIssueRelation } from './issue-relation-write'

const mocks = vi.hoisted(() => ({ rawRequest: vi.fn() }))
vi.mock('./client', () => ({
  getClients: () => [{ workspace: { id: 'w1' }, apiKey: 'inert-fixture' }],
  isAuthError: () => false
}))
vi.mock('./linear-sdk', () => ({
  createLinearClient: () => ({ client: { rawRequest: mocks.rawRequest } })
}))

const issue = { id: 'issue-1', identifier: 'ENG-1', title: 'Title', url: 'https://example.com/1' }
const relatedIssue = { ...issue, id: 'issue-2', identifier: 'ENG-2' }
const unconfirmed = () =>
  linearError('linear_write_unconfirmed', 'Read the relations before retrying.')

beforeEach(() => {
  vi.useFakeTimers()
  mocks.rawRequest.mockReset()
})
afterEach(() => vi.useRealTimers())

it.each(['add', 'remove'] as const)(
  'does not %s after a held relation scan loses its caller or deadline',
  async (operation) => {
    for (const reason of ['caller', 'deadline']) {
      const caller = new AbortController()
      let finish = () => {}
      mocks.rawRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                data: {
                  issue: {
                    relations: {
                      nodes:
                        operation === 'remove' ? [{ id: 'r1', type: 'blocks', relatedIssue }] : [],
                      pageInfo: { hasNextPage: false }
                    }
                  }
                }
              })
          })
      )
      let outcome: unknown
      const pending = runLinearWriteAction(
        async () => null,
        (_owner, options) =>
          writeIssueRelation({
            issue,
            relatedIssue,
            relationship: 'blocks',
            operation,
            workspaceId: 'w1',
            ...options
          }),
        unconfirmed,
        () => linearError('linear_write_failed', 'Failed'),
        caller.signal
      ).catch((error) => {
        outcome = error
      })
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.rawRequest).toHaveBeenCalledTimes(1)
        if (reason === 'caller') {
          caller.abort()
        } else {
          await vi.advanceTimersByTimeAsync(25_000)
        }
        await pending
        expect(outcome).toMatchObject({ code: 'linear_timeout' })
        finish()
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.rawRequest).toHaveBeenCalledTimes(1)
        mocks.rawRequest.mockClear()
        await Promise.all([acquire(), acquire(), acquire(), acquire()])
        for (let i = 0; i < 4; i++) {
          release()
        }
      } finally {
        finish()
        await pending
      }
    }
  }
)

it('removes cancelled relation queue waits without leaking a permit or invoking Linear', async () => {
  await Promise.all([acquire(), acquire(), acquire(), acquire()])
  const caller = new AbortController()
  const pending = writeIssueRelation({
    issue,
    relatedIssue,
    relationship: 'blocks',
    operation: 'add',
    workspaceId: 'w1',
    signal: caller.signal
  })
  caller.abort(new Error('disconnected'))
  try {
    await expect(pending).rejects.toThrow('disconnected')
  } finally {
    for (let i = 0; i < 4; i++) {
      release()
    }
  }
  expect(mocks.rawRequest).not.toHaveBeenCalled()
  await Promise.all([acquire(), acquire(), acquire(), acquire()])
  for (let i = 0; i < 4; i++) {
    release()
  }
})
