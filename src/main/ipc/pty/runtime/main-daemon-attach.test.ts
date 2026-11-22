import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import { attachPtyFromRuntimeController } from './main-daemon-attach'

const WORKTREE_ID = 'repo-1::/tmp/wt'
const PTY_ID = `${WORKTREE_ID}@@1a2b3c4d`
const INCARNATION_ID = '11111111-1111-4111-8111-111111111111'

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state: { connected: boolean; incarnationId: string }
  ) => unknown
}

const priorProvider = getLocalPtyProvider()

afterEach(() => {
  setLocalPtyProvider(priorProvider)
})

function installDaemonAttach(result: PtySpawnResult): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main's attach calls only attach on the provider.
  setLocalPtyProvider({ attach: async () => result } as unknown as IPtyProvider)
}

describe('main attach of a surviving daemon session', () => {
  // After an app or server restart, a background worker terminal that no pane mounts is attached
  // by main alone; the daemon still reports the agent this incarnation launched.
  it('restores the launched agent the daemon reports', async () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordPtyWorktree is the runtime's own inventory record writer.
    ;(runtime as unknown as RuntimeInternals).recordPtyWorktree(PTY_ID, WORKTREE_ID, {
      connected: true,
      incarnationId: INCARNATION_ID
    })
    installDaemonAttach({
      id: PTY_ID,
      incarnationId: INCARNATION_ID,
      launchAgent: 'claude',
      launchNote: null
    })

    await expect(attachPtyFromRuntimeController({ runtime }, PTY_ID)).resolves.toBe(true)

    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('claude')
  })
})
