import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectDescendantRows } from '../../pty/process-retirement/pty-descendant-termination'
import type { ProcessTableRow } from '../../pty/process-retirement/pty-process-table-parser'

const { readTerminalPs, terminateDescendantSnapshotWithVerdict } = vi.hoisted(() => ({
  readTerminalPs: vi.fn(),
  terminateDescendantSnapshotWithVerdict: vi.fn()
}))
vi.mock('../../pty/process-retirement/terminal-process-rows', () => ({ readTerminalPs }))
vi.mock('../../pty/process-retirement/pty-descendant-exit-verification', () => ({
  terminateDescendantSnapshotWithVerdict
}))

import { terminateShutdownDescendants } from './terminal-descendant-shutdown'

const STARTED = 'Mon Jul 13 12:54:47 2026'
const CAPTURED_AT = 1_000

function row(pid: number, ppid: number): ProcessTableRow {
  return { pid, ppid, pgid: pid, startedAt: STARTED }
}

function snapshotOf(...descendants: ProcessTableRow[]): ReturnType<typeof collectDescendantRows> {
  return collectDescendantRows(10, [row(10, 1), ...descendants], CAPTURED_AT)
}

async function shellPidFor(
  snapshot: ReturnType<typeof collectDescendantRows>
): Promise<number | undefined> {
  await terminateShutdownDescendants(snapshot, true)
  return terminateDescendantSnapshotWithVerdict.mock.calls[0]?.[1]?.shellPid
}

describe('shutdown descendant hang-up gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    terminateDescendantSnapshotWithVerdict.mockResolvedValue('exited')
  })

  it('hangs up a lone login shell', async () => {
    readTerminalPs.mockResolvedValue('-zsh\n')

    await expect(shellPidFor(snapshotOf(row(20, 10)))).resolves.toBe(20)
    expect(readTerminalPs).toHaveBeenCalledWith(['-ww', '-o', 'command=', '-p', '20'], 250)
  })

  it.each(['-/bin/zsh\n', 'zsh -l\n', '/bin/bash --login -i\n'])(
    'hangs up a bare interactive shell %j',
    async (command) => {
      readTerminalPs.mockResolvedValue(command)

      await expect(shellPidFor(snapshotOf(row(20, 10)))).resolves.toBe(20)
    }
  )

  it.each(['bash script.sh\n', "zsh -c 'trap cleanup TERM; sleep 60'\n"])(
    'keeps the SIGTERM grace for a shell running %j',
    async (command) => {
      readTerminalPs.mockResolvedValue(command)

      await expect(shellPidFor(snapshotOf(row(20, 10)))).resolves.toBeUndefined()
    }
  )

  it('keeps the SIGTERM grace for a program exec-ed in place of the shell', async () => {
    readTerminalPs.mockResolvedValue('node server.js\n')

    await expect(shellPidFor(snapshotOf(row(20, 10)))).resolves.toBeUndefined()
  })

  it('keeps the SIGTERM grace when the command cannot be read', async () => {
    readTerminalPs.mockResolvedValue(null)

    await expect(shellPidFor(snapshotOf(row(20, 10)))).resolves.toBeUndefined()
  })

  it('keeps the SIGTERM grace when the shell has other descendants', async () => {
    readTerminalPs.mockResolvedValue('-zsh\n')

    await expect(shellPidFor(snapshotOf(row(20, 10), row(30, 20)))).resolves.toBeUndefined()
    expect(readTerminalPs).not.toHaveBeenCalled()
  })

  it('never hangs up outside the login wrapper', async () => {
    await terminateShutdownDescendants(snapshotOf(row(20, 10)), false)

    expect(terminateDescendantSnapshotWithVerdict.mock.calls[0]?.[1]?.shellPid).toBeUndefined()
    expect(readTerminalPs).not.toHaveBeenCalled()
  })
})
