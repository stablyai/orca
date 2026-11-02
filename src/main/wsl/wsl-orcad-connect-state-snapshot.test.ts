import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../ssh/remote-exec/remote-exec-command'
import { runProcess } from '@orca/process-host'

vi.mock('../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import {
  emptyOrcadActivationRecord,
  serializeOrcadActivationRecord,
  withActivatedVersion
} from '../managed-server/activation/orcad-activation-record'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import {
  createWslOrcadConnectStateReader,
  parseWslOrcadConnectState,
  wslOrcadConnectStateHints
} from './wsl-orcad-connect-state-snapshot'

const mockExec = vi.mocked(execCommand)
const host = getRemoteHostPlatform('linux-x64')
const ACTIVE = withActivatedVersion(
  emptyOrcadActivationRecord(),
  '0.1.0+aa01',
  null,
  new Date('2026-02-02T00:00:00.000Z')
)
let home: string

function target() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the transport is never used.
  const conn = Object.create(null) as OrcadHostTransport
  return { conn, host, remoteHome: home, userDataDir: join(home, '.orca') }
}

function write(relative: string, content: string): void {
  const path = join(home, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-wsl-connect-state-'))
  mockExec.mockReset()
  mockExec.mockImplementation(async (_conn, command) => {
    const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout
  })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('WSL connect state snapshot', () => {
  it('reads the record, a pending journal, the instance lock and a held fence together', async () => {
    write('.orca-remote/orcad-active.json', serializeOrcadActivationRecord(ACTIVE))
    write('.orca-remote/.orcad-activation-transaction/transaction.json', '{"partial"')
    mkdirSync(join(home, '.orca-remote/.orcad-activation-transaction/.install-lock'))
    write('.orca/orcad.lock', '{"pid":7}\n')
    const reader = createWslOrcadConnectStateReader()

    await expect(reader.readActivationRecord(target())).resolves.toEqual(ACTIVE)

    expect(mockExec).toHaveBeenCalledOnce()
    expect(reader.snapshot()).toMatchObject({
      transactionAbsent: false,
      instanceLock: { state: 'present', raw: '{"pid":7}' },
      fenceOpen: false
    })
  })

  it('fails closed on an oversized record, as the plain read does', async () => {
    write('.orca-remote/orcad-active.json', `"${'x'.repeat(70 * 1024)}"`)
    const reader = createWslOrcadConnectStateReader()

    // The plain read refuses an oversized file too (exit 65), so the connect still fails closed.
    await expect(reader.readActivationRecord(target())).rejects.toThrow()
    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(reader.snapshot()).toBeNull()
  })

  it('falls back to the plain record read when the answer has another shape', async () => {
    write('.orca-remote/orcad-active.json', serializeOrcadActivationRecord(ACTIVE))
    mockExec.mockImplementationOnce(async () => 'startup noise\n')
    const reader = createWslOrcadConnectStateReader()

    await expect(reader.readActivationRecord(target())).resolves.toEqual(ACTIVE)

    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(reader.snapshot()).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('WSL connect state snapshot fallbacks', () => {
  it('falls back to the plain read when the snapshot command itself fails', async () => {
    write('.orca-remote/orcad-active.json', serializeOrcadActivationRecord(ACTIVE))
    mockExec.mockImplementationOnce(async () => {
      throw new Error('transport closed')
    })
    const reader = createWslOrcadConnectStateReader()

    await expect(reader.readActivationRecord(target())).resolves.toEqual(ACTIVE)
    expect(reader.snapshot()).toBeNull()
  })

  it('gives no hints when only the fallback read could answer the record', async () => {
    write('.orca-remote/orcad-active.json', serializeOrcadActivationRecord(ACTIVE))
    mockExec.mockImplementationOnce(
      async () =>
        'UNREADABLE\n__ORCA_WSL_CONNECT_STATE_END__\nABSENT\n__ORCA_WSL_CONNECT_STATE_END__\n' +
        'ABSENT\n__ORCA_WSL_CONNECT_STATE_END__\nNONE\n__ORCA_WSL_CONNECT_STATE_END__\nOPEN\n'
    )
    const reader = createWslOrcadConnectStateReader()

    await expect(reader.readActivationRecord(target())).resolves.toEqual(ACTIVE)
    expect(reader.snapshot()).toBeNull()
  })
})

describe.runIf(process.platform === 'linux')('WSL connect state snapshot on a Linux guest', () => {
  it("reads the lock holder's identity in the same command", async () => {
    write('.orca/orcad.lock', `${JSON.stringify({ pid: process.pid, version: '0.1.0' })}\n`)
    const reader = createWslOrcadConnectStateReader()

    await reader.readActivationRecord(target())

    expect(mockExec).toHaveBeenCalledOnce()
    const lock = reader.snapshot()?.instanceLock
    expect(lock?.state === 'present' && lock.holder?.pid).toBe(process.pid)
    expect(lock?.state === 'present' && lock.holder?.guest.orcad).toMatch(`${process.pid}:`)
  })
})

describe('parseWslOrcadConnectState', () => {
  const end = '\n__ORCA_WSL_CONNECT_STATE_END__\n'
  const stat = (pid: number) =>
    `${pid} (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 77 0`
  const identity = (pid: number) =>
    `PID ${pid}\n0f6e1d2c-3b4a-4958-8776-655443322110\n--orca-identity--\n${stat(1)}\n` +
    `--orca-identity--\n${stat(pid)}\n--orca-identity--\n`
  const answer = (holder: string) =>
    `ABSENT${end}ABSENT${end}PRESENT\n{"pid":9}${end}${holder}${end}OPEN\n`

  it('attaches the holder identity to a present lock, and nothing it cannot parse', () => {
    const lock = parseWslOrcadConnectState(answer(identity(9)))?.instanceLock
    expect(lock).toMatchObject({ state: 'present', holder: { pid: 9, guest: { orcad: '9:77' } } })
    expect(parseWslOrcadConnectState(answer('NONE'))?.instanceLock).toEqual({
      state: 'present',
      raw: '{"pid":9}'
    })
    expect(parseWslOrcadConnectState(answer('PID 9\nnoise'))?.instanceLock).not.toHaveProperty(
      'holder'
    )
  })

  it('rejects a truncated answer', () => {
    expect(parseWslOrcadConnectState('ABSENT\n__ORCA_WSL_CONNECT_STATE_END__\n')).toBeNull()
  })
})

describe('wslOrcadConnectStateHints', () => {
  const snapshot = {
    activation: { state: 'ok' as const, record: ACTIVE },
    transactionAbsent: true,
    instanceLock: { state: 'absent' as const },
    fenceOpen: true
  }

  it('stops hinting once recovery, adoption or admission replaced the record', () => {
    const hints = wslOrcadConnectStateHints(snapshot, ACTIVE)
    const replaced = { ...ACTIVE }
    expect(hints.instanceLock(replaced)).toBeUndefined()
    expect(hints.deployPreRead(replaced)).toEqual({})
  })
})
