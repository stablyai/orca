import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { RexFreshIntentJournal } from './rex-fresh-intent'
import { RexPrivateJournal } from './rex-private-journal'

describe.skipIf(process.platform === 'win32')('Rex durable fresh intent recovery', () => {
  it('recovers only a dead owner, serializes recovery, and preserves legacy or ambiguous evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-intent-test-'))
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const pid = child.pid
    if (!pid) {
      throw new Error('No test child PID')
    }
    try {
      await once(child, 'exit')
      const journal = new RexFreshIntentJournal(dir)
      const intents = new RexPrivateJournal(join(dir, 'fresh'))
      const evidence = new RexPrivateJournal(join(dir, 'fresh-evidence'))
      const id = 'rex-'.concat(randomUUID())
      const attempt = randomUUID()
      const key = 'test.json'
      await intents.publish(key, { version: 2, id, attempt, ownerPid: pid })
      const results = await Promise.all([
        journal.recover(key, async (_intent, dispatch, released) => !dispatch && !released),
        new RexFreshIntentJournal(dir).recover(
          key,
          async (_intent, dispatch, released) => !dispatch && !released
        )
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await journal.read(key)).toBeNull()
      const active = await journal.reserve(key, id)
      expect(await journal.recover(key, async () => true)).toBe(false)
      await active.release()
      await intents.publish(key, { version: 1, id })
      expect(await journal.recover(key, async () => true)).toBe(false)
      await intents.remove(key)
      await intents.publish(key, { version: 2, id, attempt, ownerPid: pid })
      const server = { host_id: 'host', instance_id: 'server' }
      const label = 'orca-rex-'.concat(randomUUID())
      await evidence.publish('dispatch-'.concat(attempt, '.json'), { server, label })
      expect(
        await journal.recover(key, async (_intent, dispatch, released) => !dispatch && !released)
      ).toBe(false)
      expect(await journal.read(key)).not.toBeNull()
      const incarnationId = randomUUID()
      await evidence.publish('released-'.concat(attempt, '.json'), { incarnationId })
      expect(
        await journal.recover(
          key,
          async (_intent, dispatch, released) =>
            dispatch?.label === label && released === incarnationId
        )
      ).toBe(true)
      expect(await journal.read(key)).toBeNull()
      expect(await evidence.listNames()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
