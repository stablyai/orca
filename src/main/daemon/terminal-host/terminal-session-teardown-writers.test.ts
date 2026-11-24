import { describe, expect, it, vi } from 'vitest'
import type { DescendantSnapshot } from '../../pty/process-retirement/pty-descendant-termination'

const { sweep } = vi.hoisted((): { sweep: { snapshot: DescendantSnapshot | null } } => ({
  sweep: { snapshot: null }
}))
vi.mock('../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: async (
    _pid: number,
    killRoot: () => void,
    deps: { terminateDescendants: (snapshot: DescendantSnapshot) => Promise<unknown> }
  ) => {
    await deps.terminateDescendants(sweep.snapshot!)
    killRoot()
  }
}))
vi.mock('../sessions/terminal-descendant-shutdown', () => ({
  terminateShutdownDescendants: async () => 'exited'
}))

import { TerminalSessionTeardown } from './terminal-session-teardown'
import type { Session } from '../sessions/session'

function liveCodexSession(): Session {
  const fields = {
    pid: 4242,
    launchAgent: 'codex',
    shellIsRootChild: false,
    isAlive: true,
    isTerminating: false,
    beginTermination: () => true,
    terminateOwnedTree: () => 'unsupported',
    forceKillAndWaitForExit: async () => {
      fields.isAlive = false
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown reads only these session fields.
  return fields as unknown as Session
}

async function writersExitedAfterStop(snapshot: DescendantSnapshot): Promise<boolean> {
  sweep.snapshot = snapshot
  const teardown = new TerminalSessionTeardown(new Map([['pty-a', liveCodexSession()]]))
  const killed = teardown.kill('pty-a', true, () => {})
  const writers = teardown.writersExited('pty-a')
  await killed
  return await writers
}

describe('teardown writer evidence', () => {
  it('proves writers gone when the live root was observed with no descendants', async () => {
    await expect(
      writersExitedAfterStop({
        root: { pid: 4242, startedAt: 'Mon Nov 23 22:00:00 2026' },
        rootPgid: 4242,
        descendants: [],
        capturedAtMs: 0
      })
    ).resolves.toBe(true)
  })

  it('proves nothing when the scan missed, duplicated or saw a zombie root', async () => {
    await expect(
      writersExitedAfterStop({ rootPgid: null, descendants: [], capturedAtMs: 0 })
    ).resolves.toBe(false)
  })
})
