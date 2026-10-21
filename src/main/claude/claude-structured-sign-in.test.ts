import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const entry = z.looseObject({ kind: z.string() })
const capturedFrame = z.object({ at: z.number(), frame: z.record(z.string(), z.unknown()) })

async function replay(account: 'system' | 'managed', removeTypedError = false) {
  const bodies: AgentJournalItemBody[] = []
  const translator = createClaudeJournalTranslator({
    account: () => account,
    sink: {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const capture = await readFile(
    new URL('./__fixtures__/claude-lifecycle-capture-auth-failed.jsonl', import.meta.url),
    'utf8'
  )
  for (const line of capture.trim().split('\n')) {
    const value: unknown = JSON.parse(line)
    if (entry.parse(value).kind !== 'frame') {
      continue
    }
    const { at, frame } = capturedFrame.parse(value)
    if (removeTypedError) {
      delete frame.error
    }
    translator.handle({ type: 'message', sessionId: 'session', observedAt: at, message: frame })
  }
  translator.dispose()
  return bodies
}

describe('captured Claude authentication failure', () => {
  it.each(['system', 'managed'] as const)(
    'shows one failure with %s sign-in advice and Claude detail',
    async (account) => {
      const bodies = await replay(account)
      const failures = bodies.flatMap((body) =>
        body.kind === 'status' && body.failure ? [body] : []
      )
      expect(failures).toHaveLength(1)
      expect(failures[0]?.failure).toMatchObject({
        kind: 'notSignedIn',
        account,
        detail: { text: 'Not logged in · Please run /login', audience: 'person' }
      })
      expect(failures[0]?.text).toContain(
        account === 'managed' ? 'Sign in again in Claude Accounts settings.' : 'claude auth login'
      )
      expect(
        bodies.filter((body) => body.kind === 'message' && body.role === 'assistant')
      ).toHaveLength(0)
      expect(
        bodies.flatMap((body) =>
          body.kind === 'status' && body.text.includes('Not logged in') ? [body] : []
        )
      ).toHaveLength(1)
    }
  )
  it('does not infer authentication from result text without the typed assistant error', async () => {
    expect(
      (await replay('system', true)).some(
        (body) => body.kind === 'status' && body.failure?.kind === 'notSignedIn'
      )
    ).toBe(false)
  })
})
