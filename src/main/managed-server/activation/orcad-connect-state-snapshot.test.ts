import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { serializeOrcadActivationTransaction } from './orcad-activation-transaction'
import { createOrcadActivationTransaction } from './orcad-activation-transaction-transitions'
import { emptyOrcadActivationRecord } from './orcad-activation-record'
import { orcadConnectStateCommand, parseOrcadConnectState } from './orcad-connect-state-snapshot'

const host = getRemoteHostPlatform('linux-x64')
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-connect-state-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

async function snapshot() {
  const result = await runProcess({
    program: '/bin/sh',
    args: ['-c', orcadConnectStateCommand(host, home)]
  })
  return parseOrcadConnectState(result.stdout)
}

describe.skipIf(process.platform === 'win32')('the SSH connect state snapshot', () => {
  it('reads an untouched host as idle', async () => {
    expect(await snapshot()).toEqual({
      activation: { state: 'absent' },
      transactionAbsent: true,
      fenceOpen: true
    })
  })

  // Idle hints skip recovery's own reads, so a journal or a held fence must never read as idle.
  it('reports an interrupted activation and a held fence', async () => {
    const remoteDir = join(home, '.orca-remote')
    mkdirSync(join(remoteDir, '.orcad-activation-transaction', '.install-lock'), {
      recursive: true
    })
    writeFileSync(
      join(remoteDir, '.orcad-activation-transaction', 'transaction.json'),
      serializeOrcadActivationTransaction(
        createOrcadActivationTransaction({
          transactionId: '00000000-0000-4000-8000-000000000001',
          candidateVersion: '0.2.0+bb01',
          recordBefore: emptyOrcadActivationRecord(),
          snapshotDirName: 'pre-1',
          now: new Date(0)
        })
      )
    )
    expect(await snapshot()).toMatchObject({ transactionAbsent: false, fenceOpen: false })
  })
})
