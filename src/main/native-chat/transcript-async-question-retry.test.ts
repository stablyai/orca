import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatAsyncQuestionsField } from '../../shared/native-chat-async-questions'
import type * as BoundaryScanModule from './transcript-async-question-boundary-scan'
import { subscribeNativeChatTranscript } from './transcript-watch'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'

// 1-based scan calls that reject.
const scanControl = vi.hoisted(() => {
  const failing: number[] = []
  return { calls: 0, failing }
})

vi.mock('./transcript-async-question-boundary-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof BoundaryScanModule>()
  return {
    ...actual,
    scanCodexAsyncQuestionFactsBefore: vi.fn(
      (...args: Parameters<typeof actual.scanCodexAsyncQuestionFactsBefore>) => {
        scanControl.calls += 1
        if (scanControl.failing.includes(scanControl.calls)) {
          return Promise.reject(new Error('gated read timed out'))
        }
        return actual.scanCodexAsyncQuestionFactsBefore(...args)
      }
    )
  }
})

let root: string | null = null
const subscriptions: NativeChatTranscriptSubscription[] = []

afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) {
    subscription.unsubscribe()
  }
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

const line = (record: unknown): string => `${JSON.stringify(record)}\n`

async function writeRolloutWithQuestion(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'orca-async-retry-'))
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(
    filePath,
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }) +
      line({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            id: 'c',
            content: [{ type: 'Text', text: 'Color?' }],
            delivery: 'async',
            questions: [{ title: 'Color?' }]
          }
        }
      })
  )
  return filePath
}

function subscribeRecordingFields(
  filePath: string,
  sessionId: string
): { fields: NativeChatAsyncQuestionsField[]; subscribed: Promise<void> } {
  const fields: NativeChatAsyncQuestionsField[] = []
  const record = (field: NativeChatAsyncQuestionsField | undefined): void => {
    if (field) {
      fields.push(field)
    }
  }
  const subscribed = subscribeNativeChatTranscript({
    agent: 'codex',
    sessionId,
    filePath,
    initialLimit: 40,
    debounceMs: 5,
    reconciliationIntervalMs: 20,
    onInitialSnapshot: (_m, _h, _b, _e, _l, asyncQuestions) => record(asyncQuestions),
    onReplace: (_m, _h, _b, _l, asyncQuestions) => record(asyncQuestions),
    onAppend: (_m, _l, asyncQuestions) => record(asyncQuestions)
  }).then((subscription) => {
    subscriptions.push(subscription)
  })
  return { fields, subscribed }
}

describe('a failed async-question reconstruction', () => {
  it('publishes absent, then recovers through the watcher reconcile with no file change', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scanControl.calls = 0
    scanControl.failing = [1]
    const filePath = await writeRolloutWithQuestion()
    const { fields, subscribed } = subscribeRecordingFields(filePath, 'session')
    await subscribed
    await vi.waitFor(() => expect(fields.at(-1)?.state).toBe('absent'))
    // The first retry waits out the backoff (1 s), then rides an idle reconcile drain.
    await vi.waitFor(() => expect(fields.at(-1)?.state).toBe('ready'), { timeout: 5_000 })
    expect(fields.map((field) => field.state)).toEqual(['pending', 'absent', 'ready'])
  })

  it('publishes a retry that another subscriber of the same idle file already folded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scanControl.calls = 0
    scanControl.failing = [2]
    const filePath = await writeRolloutWithQuestion()
    const first = subscribeRecordingFields(filePath, 'desktop')
    const second = subscribeRecordingFields(filePath, 'phone')
    await Promise.all([first.subscribed, second.subscribed])
    await vi.waitFor(() => expect(scanControl.calls).toBe(2))
    // The failed subscriber's retry is answered from the other's cached fold, with no rescan.
    await vi.waitFor(
      () =>
        expect([first.fields.at(-1)?.state, second.fields.at(-1)?.state]).toEqual([
          'ready',
          'ready'
        ]),
      { timeout: 5_000 }
    )
    expect(scanControl.calls).toBe(2)
  })
})
