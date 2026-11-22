import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isFirstWorkRenameSettled,
  resetFirstWorkBranchRenameState,
  runningFirstWorkAttempt,
  startFirstWorkAttempt,
  type FirstWorkRenameVerdict
} from './first-work-rename-attempts'
import { isFirstWorkGenerationBackingOff } from './first-work-generation-backoff'
import {
  leaseNativeFirstMessageRead,
  readNativeFirstMessage,
  resetNativeFirstMessageReads,
  type NativeFirstMessageLookup
} from './first-work-native-first-message'

import type { JournalFirstSubmittedPrompt } from '../../native-chat/agent-session-journal/journal-domain-first-submitted-prompt'

const ID = 'repo::/repo/wt'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  resetFirstWorkBranchRenameState()
  resetNativeFirstMessageReads()
})

describe('first-work attempt admission', () => {
  it('does not let a settled or backed-off incarnation gate its recreated successor', async () => {
    let incarnation = 'A'
    const deps = { readIncarnation: () => incarnation }
    await startFirstWorkAttempt(
      ID,
      'A',
      async () => ({ outcome: { kind: 'renamed' }, settles: true }),
      deps
    ).promise
    expect(isFirstWorkRenameSettled(ID, 'A')).toBe(true)
    incarnation = 'B'
    expect(isFirstWorkRenameSettled(ID, 'B')).toBe(false)

    await startFirstWorkAttempt(
      ID,
      'B',
      async () => ({ outcome: { kind: 'failed' }, settles: false, generationFailed: true }),
      deps
    ).promise
    expect(isFirstWorkGenerationBackingOff(ID, 'B')).toBe(true)
    expect(isFirstWorkGenerationBackingOff(ID, 'C')).toBe(false)
  })

  it('supersedes a replaced incarnation’s pending attempt and keeps the new entry when the old one finishes', async () => {
    let incarnation = 'A'
    const deps = { readIncarnation: () => incarnation }
    const oldRun = deferred<FirstWorkRenameVerdict>()
    const old = startFirstWorkAttempt(ID, 'A', () => oldRun.promise, deps)
    incarnation = 'B'
    expect(runningFirstWorkAttempt(ID, 'B')).toBeNull()
    const newRun = deferred<FirstWorkRenameVerdict>()
    const current = startFirstWorkAttempt(ID, 'B', () => newRun.promise, deps)

    oldRun.resolve({ outcome: { kind: 'renamed' }, settles: true })
    await old.promise
    expect(runningFirstWorkAttempt(ID, 'B')?.attemptId).toBe(current.attemptId)
    // The replaced attempt's settled verdict is not recorded for the successor.
    expect(isFirstWorkRenameSettled(ID, 'B')).toBe(false)

    newRun.resolve({ outcome: { kind: 'nothing-yet' }, settles: false })
    await current.promise
    expect(runningFirstWorkAttempt(ID, 'B')).toBeNull()
  })
})

describe('native first-message read lease', () => {
  it('joins a draining read per incarnation and caps physical reads feature-wide until they settle', async () => {
    const reads = new Map<string, ReturnType<typeof deferred<NativeFirstMessageLookup>>>()
    const physical = vi.fn((key: string) => {
      const read = deferred<NativeFirstMessageLookup>()
      reads.set(key, read)
      return read.promise
    })
    const lease = (key: string) =>
      leaseNativeFirstMessageRead(
        key,
        () => true,
        () => physical(key)
      )

    const a1 = lease('a')
    const a2 = lease('a')
    void lease('b')
    await expect(lease('c')).resolves.toEqual({ kind: 'unreadable' })
    expect(physical.mock.calls.map(([key]) => key)).toEqual(['a', 'b'])

    reads.get('a')!.resolve({ kind: 'none' })
    await expect(a1).resolves.toEqual({ kind: 'none' })
    await expect(a2).resolves.toEqual({ kind: 'none' })
    void lease('c')
    expect(physical).toHaveBeenCalledTimes(3)

    reads.get('b')!.reject(new Error('reader closed'))
    reads.get('c')!.resolve({ kind: 'none' })
    await Promise.resolve()
    await vi.waitFor(() => {
      void lease('d')
      expect(physical).toHaveBeenCalledWith('d')
    })
  })
})

describe('native first-message ordering', () => {
  const found = (prompt: string, submittedAt: number, sequence: number) =>
    ({ kind: 'found', prompt, submittedAt, sequence }) as const

  it('breaks an equal submission time by sequence, whatever the session order', async () => {
    const firsts: Record<string, JournalFirstSubmittedPrompt> = {
      a: found('Later in sequence', 100, 7),
      b: found('Earlier in sequence', 100, 3)
    }
    for (const order of [
      ['a', 'b'],
      ['b', 'a']
    ] as const) {
      await expect(
        readNativeFirstMessage(
          {
            listSessions: async () => ({ sessionIds: [...order], hasUnreadable: false }),
            readFirst: async (id) => firsts[id] ?? { kind: 'none' }
          },
          0
        )
      ).resolves.toMatchObject({ prompt: 'Earlier in sequence' })
    }
  })

  it('reports an incomplete session scan, never a partial set as found or as a miss', async () => {
    await expect(
      readNativeFirstMessage(
        {
          listSessions: async () => ({ sessionIds: ['a', 'b'], hasUnreadable: false }),
          readFirst: async (id) => (id === 'a' ? found('Found', 100, 1) : { kind: 'incomplete' })
        },
        0
      )
    ).resolves.toEqual({ kind: 'incomplete' })
  })
})
