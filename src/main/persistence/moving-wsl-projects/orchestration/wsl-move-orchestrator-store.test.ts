import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveJournalKey } from '../../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import { WslMoveOrchestrator } from '../wsl-move-orchestrator'
import { fakePorts } from './wsl-move-orchestrator.test-support'
import {
  readWslMoveOrchestratorRecords,
  writeWslMoveOrchestratorRecords,
  wslMoveOrchestratorStorePath
} from './wsl-move-orchestrator-store'

const declined = (distro: string): WslMoveOrchestratorRecord => ({
  distro,
  state: { kind: 'parked', reason: 'declined', cause: 'released-here' },
  attempts: 0,
  appVersion: '1.0.0',
  updatedAt: 1_000
})

describe('WSL move orchestrator sidecar', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-orchestrator-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('never rewrites a sidecar it could not read, so another distro keeps its decline', async () => {
    writeWslMoveOrchestratorRecords(
      userDataPath,
      new Map([
        [wslMoveJournalKey('Ubuntu-A'), declined('Ubuntu-A')],
        [wslMoveJournalKey('Ubuntu-B'), declined('Ubuntu-B')]
      ])
    )
    expect(
      [...readWslMoveOrchestratorRecords(userDataPath).values()].map((record) => record.distro)
    ).toEqual(['Ubuntu-A', 'Ubuntu-B'])

    const path = wslMoveOrchestratorStorePath(userDataPath)
    const unreadable = '{"version":1,"distros":{"local-wsl:ubuntu-b":'
    writeFileSync(path, unreadable)

    const orchestrator = new WslMoveOrchestrator({
      ...fakePorts(),
      load: () => readWslMoveOrchestratorRecords(userDataPath),
      save: (records) => writeWslMoveOrchestratorRecords(userDataPath, records)
    })
    try {
      await orchestrator.userAction('Ubuntu-A', 'not-now')
      expect(readFileSync(path, 'utf8')).toBe(unreadable)
      expect(console.warn).toHaveBeenCalledWith(
        '[wsl-move] Orchestrator state not saved:',
        expect.any(Error)
      )
    } finally {
      orchestrator.dispose()
    }
  })
})
