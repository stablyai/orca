// verify-15b: a WSL host pane's wake joined the new prompt onto the restored one.
import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
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
