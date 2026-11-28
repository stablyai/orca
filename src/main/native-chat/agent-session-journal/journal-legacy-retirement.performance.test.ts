import { expect, it, vi } from 'vitest'
import { acquireOrcadInstanceLock } from '../../orcad/instance-lock/orcad-instance-lock'
import * as lockFile from '../../orcad/instance-lock/orcad-instance-lock-reclaim'
import { JournalLegacyRetirement } from './journal-legacy-retirement'
import { setLegacyJournalRetirementHost } from './journal-legacy-retirement-outcome'
import { cleanup, profile } from './journal-legacy-retirement.test-fixture'

it.each([5, 50])(
  'reads the profile lock once over %i proof pages and never on done ticks',
  async (pages) => {
    const store = await profile()
    const lock = acquireOrcadInstanceLock(store.root, {
      enforcePrivateDataRoot: false,
      startedAtMs: () => 1,
      incarnation: () => null,
      machineIdentity: () => 'retirement-performance-test'
    })
    cleanup.push(() => lock.release())
    const reads = vi.spyOn(lockFile, 'readBoundedLockFile')
    cleanup.push(() => reads.mockRestore())
    let accepting = false
    const report = vi.fn(async () => accepting)
    setLegacyJournalRetirementHost({ report, accepting: () => accepting })
    cleanup.push(() => setLegacyJournalRetirementHost(undefined))
    let remaining = pages
    const retirement = new JournalLegacyRetirement(
      store.root,
      store.writer,
      {
        ...store.readers,
        legacyProof: async (cursor) => ({
          sessions: [],
          next: --remaining > 0 ? { table: cursor.table, after: String(remaining) } : null
        })
      },
      { ensure: store.convert },
      async () => true,
      (error) => {
        throw error
      },
      undefined,
      undefined,
      undefined,
      { present: () => {}, check: async () => {} },
      '1.0.1'
    )
    cleanup.push(() => retirement.stop())
    await retirement.run()
    expect(remaining).toBe(0)
    expect(reads).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledOnce()
    reads.mockClear()
    for (let tick = 0; tick < pages; tick++) {
      await retirement.run()
    }
    accepting = true
    await retirement.run()
    expect(report).toHaveBeenCalledTimes(2)
    expect(reads).not.toHaveBeenCalled()
  }
)
