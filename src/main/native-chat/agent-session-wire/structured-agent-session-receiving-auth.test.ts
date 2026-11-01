import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import {
  createReceivingCallerFixture,
  HOME_A,
  HOME_B,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'

const entry = z.looseObject({ kind: z.string() })
const capturedFrame = z.object({ at: z.number(), frame: z.record(z.string(), z.unknown()) })

describe('recorded Claude authentication failure reaches receiving recovery', () => {
  it('uses the recorded typed failure through the production translator and current acquired fence', async () => {
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      await f.coldNative()
      f.selectB()
      await f.ensure()
      expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
      const sink = f.sinks.get(PARENT)
      if (!sink) {
        throw new Error('successful actual parent acquisition missing')
      }
      const translator = createClaudeJournalTranslator({ account: () => 'system', sink })
      try {
        // Shipping recorded CLI2.1.280 authentication_failed frames; context/fence comes from this actual host acquisition.
        const capture = await readFile(
          new URL(
            '../../claude/__fixtures__/claude-lifecycle-capture-auth-failed.jsonl',
            import.meta.url
          ),
          'utf8'
        )
        for (const line of capture.trim().split('\n')) {
          const value: unknown = JSON.parse(line)
          if (entry.parse(value).kind !== 'frame') {
            continue
          }
          const { at, frame } = capturedFrame.parse(value)
          translator.handle({ type: 'message', sessionId: PARENT, observedAt: at, message: frame })
        }
        await f.rig.host.flushStreamedEvents(PARENT)
        const snapshot = await f.rig.host.journalSnapshot(PARENT)
        expect(
          snapshot.items.some(
            (item) => item.body.kind === 'status' && item.body.failure?.kind === 'notSignedIn'
          )
        ).toBe(true)
        expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_B)
      } finally {
        translator.dispose()
      }
    } finally {
      await f.dispose()
    }
  })
})
