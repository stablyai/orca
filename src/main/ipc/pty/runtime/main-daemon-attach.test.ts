import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import type { RuntimePtyController } from '../../../runtime/terminal/lifecycle/runtime-pty-controller-contract'
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
  launchNote: PtySpawnResult['launchNote'] | undefined
): Promise<void> {
  installDaemonAttach({
    id: PTY_ID,
    incarnationId: INCARNATION_ID,
    launchAgent: 'claude',
    ...(launchNote === undefined ? {} : { launchNote })
  })
  await expect(attachPtyFromRuntimeController({ runtime }, PTY_ID)).resolves.toBe(true)
}

/** The launched-agent read as each host answers it: local POSIX admits any non-shell as 'agent',
 *  Windows/WSL/SSH cannot see one ('unknown'); the owner's fresh name settles which program it is. */
function foregroundIs(
  runtime: OrcaRuntimeService,
  foreground: 'agent' | 'shell' | 'unknown',
  name: string | null
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exact read asks the owner only for a fresh foreground name.
  runtime.setPtyController({
    confirmForegroundProcess: async () => (name === '2.1.330' ? 'claude' : name),
    setLaunchNote: () => {}
  } as unknown as RuntimePtyController)
  return vi
    .spyOn(runtime, 'readLaunchedAgentForeground')
    .mockImplementation(async (_ptyId, _agent, exact) => {
      if (exact) {
        exact.named = name === 'claude'
      }
      return foreground
    })
}

async function settled(read: ReturnType<typeof foregroundIs>): Promise<void> {
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const FOREGROUNDS = [
  ['claude by name', 'agent', 'claude', 'claude'],
  ['native claude by version name', 'agent', '2.1.330', 'claude'],
  ['vim', 'agent', 'vim', null],
  ['ssh', 'agent', 'ssh', null],
  ['codex', 'agent', 'codex', null],
  ['an unreadable Windows foreground', 'unknown', null, null],
  ['a shell', 'shell', 'zsh', null]
] as const

describe('main attach of a surviving daemon session', () => {
  // After an app or server restart, a background worker terminal that no pane mounts is attached by
  // main alone. The daemon names the agent this incarnation launched, armed (a note), never armed
  // or retired by an older daemon (null), or from a daemon that keeps no notes (undefined).
  describe.each([
    ['a held note', NOTE],
    ['no note', null],
    ['an older daemon without notes', undefined]
  ] as const)('with %s', (_label, launchNote) => {
    it.each(FOREGROUNDS)(
      'restores the launched agent only for %s in front',
      async (_case, foreground, name, expected) => {
        const runtime = survivingSession()
        const read = foregroundIs(runtime, foreground, name)
        await attachWith(runtime, launchNote)
        await settled(read)
        expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe(expected)
      }
    )
  })

  it('drops an agent an earlier attach restored once a later reattach finds vim', async () => {
    const runtime = survivingSession()
    const read = foregroundIs(runtime, 'agent', 'claude')
    await attachWith(runtime, null)
    await vi.waitFor(() => expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('claude'))

    read.mockClear()
    foregroundIs(runtime, 'agent', 'vim')
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
})
