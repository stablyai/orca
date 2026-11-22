import { afterEach, describe, expect, it, vi } from 'vitest'
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
  ptysById: Map<string, unknown>
  restoreReattachedLaunch: (
    pty: unknown,
    incarnationId: string,
    identity: { incarnationId: string; launchAgent: string },
    reattach: { launchNote: null }
  ) => void
}

const priorProvider = getLocalPtyProvider()

afterEach(() => {
  setLocalPtyProvider(priorProvider)
})

function installDaemonAttach(result: PtySpawnResult): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main's attach calls only attach on the provider.
  setLocalPtyProvider({ attach: async () => result } as unknown as IPtyProvider)
}

const NOTE = { launchToken: 'launch-1', launchConfig: { agentArgs: '', agentEnv: {} } }

function survivingSession(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordPtyWorktree is the runtime's own inventory record writer.
  ;(runtime as unknown as RuntimeInternals).recordPtyWorktree(PTY_ID, WORKTREE_ID, {
    connected: true,
    incarnationId: INCARNATION_ID
  })
  return runtime
}

async function attachWith(
  runtime: OrcaRuntimeService,
  launchNote: PtySpawnResult['launchNote']
): Promise<void> {
  installDaemonAttach({
    id: PTY_ID,
    incarnationId: INCARNATION_ID,
    launchAgent: 'claude',
    launchNote
  })
  await expect(attachPtyFromRuntimeController({ runtime }, PTY_ID)).resolves.toBe(true)
}

describe('main attach of a surviving daemon session', () => {
  // After an app or server restart, a background worker terminal that no pane mounts is attached
  // by main alone; the daemon still reports the agent this incarnation launched.
  it('restores the launched agent while it still holds the foreground', async () => {
    const runtime = survivingSession()
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')

    await attachWith(runtime, NOTE)

    await vi.waitFor(() => expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('claude'))
  })

  // No note: main never armed one, or saw the launch finish; only a shell in front proves it gone.
  it.each([
    ['agent', 'claude'],
    ['unknown', 'claude'],
    ['shell', null]
  ] as const)(
    'restores an unnoted launch unless a shell holds the foreground (%s)',
    async (foreground, expected) => {
      const runtime = survivingSession()
      const read = vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue(foreground)
      await attachWith(runtime, null)
      await vi.waitFor(() => expect(read).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe(expected)
    }
  )

  it('drops an agent an earlier attach restored once a later unnoted reattach finds a shell', async () => {
    const runtime = survivingSession()
    const read = vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
    await attachWith(runtime, null)
    await vi.waitFor(() => expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('claude'))

    read.mockResolvedValue('shell')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane reattach calls this same restore.
    const internals = runtime as unknown as RuntimeInternals
    internals.restoreReattachedLaunch(
      internals.ptysById.get(PTY_ID),
      INCARNATION_ID,
      { incarnationId: INCARNATION_ID, launchAgent: 'claude' },
      { launchNote: null }
    )
    await vi.waitFor(() => expect(runtime.getPaneTerminalAgent(PTY_ID)).toBeNull())
  })

  it('drops the restored agent once a shell holds the foreground', async () => {
    const runtime = survivingSession()
    const read = vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('shell')

    await attachWith(runtime, NOTE)

    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    await vi.waitFor(() => expect(runtime.getPaneTerminalAgent(PTY_ID)).toBeNull())
  })
})
