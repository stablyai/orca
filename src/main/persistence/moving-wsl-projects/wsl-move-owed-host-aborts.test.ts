import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'
import {
  listWslMoveOwedHostAborts,
  recordWslMoveOwedHostAbort,
  settleWslMoveOwedHostAborts
} from './wsl-move-owed-host-aborts'
import { recoverInterruptedWslMoves } from './wsl-move-reset'

let userDataPath: string
beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-owed-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(userDataPath, { recursive: true, force: true })
})

/** A record walked to `phase` through the journal's compare-and-swap. */
function seed(phase: 'source-fenced' | 'quiesced' | 'destination-staged'): string {
  const phases = ['prepared', 'source-fenced', 'quiesced', 'destination-staged'] as const
  const base = wslMoveCutoverFixture('move-1', 'prepared')
  for (const step of phases.slice(0, phases.indexOf(phase) + 1)) {
    writeWslMoveCutover(userDataPath, {
      ...base,
      phase: step,
      ...(step === 'quiesced' || step === 'destination-staged' ? { terminalRestoreHints: [] } : {})
    })
  }
  return base.migrationId
}

describe('owed host aborts', () => {
  it.each(['quiesced', 'destination-staged'] as const)(
    'a reset at %s without the host owes the host an abort, written before the record goes',
    async (phase) => {
      seed(phase)
      await recoverInterruptedWslMoves(userDataPath, () => {})

      expect(listWslMoveCutovers(userDataPath)).toEqual([])
      expect(listWslMoveOwedHostAborts(userDataPath).map((entry) => entry.migrationId)).toEqual([
        'move-1'
      ])
    }
  )

  it('a reset before the stage request owes nothing', async () => {
    seed('source-fenced')
    await recoverInterruptedWslMoves(userDataPath, () => {})

    expect(listWslMoveOwedHostAborts(userDataPath)).toEqual([])
  })

  it("settles only this distro's, keeps one the host could not answer, and drops answered ones", async () => {
    const cutover = wslMoveCutoverFixture('move-1', 'prepared')
    recordWslMoveOwedHostAbort(userDataPath, cutover)
    recordWslMoveOwedHostAbort(userDataPath, { ...cutover, migrationId: 'move-2' })
    recordWslMoveOwedHostAbort(userDataPath, {
      ...cutover,
      migrationId: 'move-other',
      journalKey: 'local-wsl:debian'
    })
    const abortByReference = vi.fn(async (reference: { migrationId: string }) => {
      if (reference.migrationId === 'move-2') {
        throw new Error('socket closed')
      }
      return {
        migrationId: reference.migrationId,
        manifestSha256: cutover.manifestSha256,
        state: 'absent' as const,
        aborted: true,
        durableAbsent: true as const
      }
    })

    await settleWslMoveOwedHostAborts(
      userDataPath,
      cutover.journalKey,
      { abortByReference },
      () => {}
    )

    expect(abortByReference.mock.calls.map(([reference]) => reference.migrationId).sort()).toEqual([
      'move-1',
      'move-2'
    ])
    expect(
      listWslMoveOwedHostAborts(userDataPath)
        .map((entry) => entry.migrationId)
        .sort()
    ).toEqual(['move-2', 'move-other'])
  })
})
