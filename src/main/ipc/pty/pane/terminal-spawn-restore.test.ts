// verify-15b: a WSL host pane's wake joined the new prompt onto the restored one.
import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { declarePendingPaneSerializer, settlePendingPaneSerializer } from './serializer-state'
import { seedHeadlessTerminalFromSpawnResult } from './terminal-spawn-restore'

async function rowsAfter(seed: string, liveOutput: string, rows: number): Promise<string[]> {
  const terminal = new Terminal({ cols: 40, rows, scrollback: 100, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(seed + liveOutput, resolve))
  const lines: string[] = []
  for (let i = 0; i < terminal.buffer.active.length; i++) {
    lines.push(terminal.buffer.active.getLine(i)?.translateToString(true).trimEnd() ?? '')
  }
  terminal.dispose()
  return lines.filter((line) => line !== '')
}

describe('seeding the host copy from a cold restore', () => {
  it('parks the cursor below the restored history, so the new shell’s prompt has its own row', async () => {
    const seedHeadlessTerminal = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seed reads only seedHeadlessTerminal from the runtime.
    const runtime = { seedHeadlessTerminal } as unknown as OrcaRuntimeService
    const result: PtySpawnResult = {
      id: 'host-pty',
      coldRestore: {
        scrollback: 'user@host:~/p8$ cd deep\r\nuser@host:~/p8/deep$ ',
        cwd: '/home/user/p8/deep',
        cols: 40,
        rows: 6
      }
    }

    seedHeadlessTerminalFromSpawnResult(runtime, result, null)

    const [, seed] = seedHeadlessTerminal.mock.calls[0]!
    expect(await rowsAfter(seed, 'user@host:~/p8/deep$ ', 6)).toEqual([
      'user@host:~/p8$ cd deep',
      'user@host:~/p8/deep$',
      'user@host:~/p8/deep$'
    ])
  })
})

describe('seeding while the window declared its own serializer', () => {
  it('still seeds a cold restore, since a hidden pane repaints from the host copy when revealed', () => {
    const seedHeadlessTerminal = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seed reads only seedHeadlessTerminal from the runtime.
    const runtime = { seedHeadlessTerminal } as unknown as OrcaRuntimeService
    const paneKey = makePaneKey('tab-cold-restore', '44444444-4444-4444-8444-444444444444')
    const generation = declarePendingPaneSerializer(paneKey, undefined)
    try {
      seedHeadlessTerminalFromSpawnResult(
        runtime,
        {
          id: 'cold-pty',
          coldRestore: { scrollback: 'restored history\r\n', cwd: '/tmp', cols: 40, rows: 6 }
        },
        paneKey
      )
    } finally {
      settlePendingPaneSerializer(paneKey, generation)
    }

    expect(seedHeadlessTerminal).toHaveBeenCalledTimes(1)
    expect(seedHeadlessTerminal.mock.calls[0]![1]).toContain('restored history')
  })
})
