import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RexRetirementJournal } from './rex-retirement-journal'
import { rexRetirementObservation } from './rex-retirement-evidence'
import type { RexSessionRecord } from './rex-session-record'
import type { ProcessTableRow } from '../../pty/process-retirement/pty-process-table-parser'

const row: ProcessTableRow = { pid: 123, ppid: 1, pgid: 123, startedAt: 'Fri Nov 27 09:00:00 2026' }

describe('Rex termination evidence', () => {
  it('distinguishes live, reaped, zombie, reused and ambiguous PID evidence', () => {
    const expected = [{ pid: row.pid, startedAt: row.startedAt }]
    expect(rexRetirementObservation(expected, [row])).toBe(false)
    expect(rexRetirementObservation(expected, [])).toBe(true)
    expect(rexRetirementObservation(expected, [{ ...row, zombie: true }])).toBe(true)
    expect(
      rexRetirementObservation(expected, [{ ...row, startedAt: 'Fri Nov 27 09:01:00 2026' }])
    ).toBe(true)
    expect(
      rexRetirementObservation(expected, [
        { ...row, zombie: true },
        { ...row, startedAt: 'other' }
      ])
    ).toBe(false)
    expect(
      rexRetirementObservation(
        [...expected, { pid: 124, startedAt: row.startedAt }],
        [{ ...row, pid: 124 }]
      )
    ).toBe(false)
  })
  it.skipIf(process.platform === 'win32')(
    'reserves once across controllers and retains unknown outcome until explicit resolution',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rex-retirement-test-'))
      try {
        const record: RexSessionRecord = {
          version: 1,
          backend: 'rex-local',
          id: `rex-${randomUUID()}`,
          incarnationId: randomUUID(),
          sessionId: `session:${randomUUID()}`,
          blockId: `block:${randomUUID()}`,
          server: { host_id: 'test', instance_id: 'test' },
          rootPid: 123,
          cwd: '/tmp'
        }
        const a = new RexRetirementJournal(directory),
          b = new RexRetirementJournal(directory)
        const attempts = await Promise.allSettled([
          a.reserve(record, [row]),
          b.reserve(record, [row])
        ])
        expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect((await b.read(record))?.identities).toEqual([
          { pid: row.pid, startedAt: row.startedAt }
        ])
        await expect(b.assertAvailable(record)).rejects.toThrow('termination outcome unknown')
        await b.assertAvailable({ ...record, incarnationId: randomUUID() })
        await b.remove(record)
        expect(await a.read(record)).toBeNull()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
