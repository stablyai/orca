import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  readWslMoveOrchestratorRecords,
  wslMoveOrchestratorStorePath,
  writeWslMoveOrchestratorRecords
} from './wsl-move-orchestrator-store'

const dirs: string[] = []

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wsl-move-orchestrator-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const deferred: WslMoveOrchestratorRecord = {
  distro: 'Ubuntu',
  state: {
    kind: 'deferred',
    blockers: [{ kind: 'process-running', ids: ['tab:leaf'], actions: ['end', 'skip-project'] }],
    rechecks: 1
  },
  attempts: 2,
  appVersion: '1.0.0',
  updatedAt: 5
}

describe('wsl-move-orchestrator store', () => {
  it('round-trips records keyed by distro', () => {
    const dir = userData()
    const records = new Map([[wslMoveJournalKey('Ubuntu'), deferred]])
    writeWslMoveOrchestratorRecords(dir, records)
    expect(readWslMoveOrchestratorRecords(dir)).toEqual(records)
  })

  it('reads a missing or unparseable file as empty', () => {
    const dir = userData()
    expect(readWslMoveOrchestratorRecords(dir).size).toBe(0)
    writeFileSync(wslMoveOrchestratorStorePath(dir), '{not json')
    expect(readWslMoveOrchestratorRecords(dir).size).toBe(0)
  })

  it('drops a bad record alone and keeps the rest', () => {
    const dir = userData()
    writeFileSync(
      wslMoveOrchestratorStorePath(dir),
      JSON.stringify({
        version: 1,
        distros: {
          a: deferred,
          b: { ...deferred, distro: 'Debian', state: { kind: 'from-a-newer-build' } }
        }
      })
    )
    expect([...readWslMoveOrchestratorRecords(dir).values()]).toEqual([deferred])
  })

  it('reads a deferred record from before re-check counting as a fresh series', () => {
    const dir = userData()
    const { rechecks: _rechecks, ...older } =
      deferred.state.kind === 'deferred' ? deferred.state : { rechecks: 0 }
    writeFileSync(
      wslMoveOrchestratorStorePath(dir),
      JSON.stringify({ version: 1, distros: { a: { ...deferred, state: older } } })
    )
    expect([...readWslMoveOrchestratorRecords(dir).values()][0]?.state).toMatchObject({
      kind: 'deferred',
      rechecks: 0
    })
  })
})
