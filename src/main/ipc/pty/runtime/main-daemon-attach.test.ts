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
  ) => Promise<void> | undefined
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
  name: string | null,
  answered: Promise<void> = Promise.resolve()
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exact read asks the owner only for a fresh foreground name.
  runtime.setPtyController({
    supportsForegroundObservation: () => true,
    confirmForegroundProcess: async () => (name === '2.1.330' ? 'claude' : name),
    setLaunchNote
  } as unknown as RuntimePtyController)
  return vi
    .spyOn(runtime, 'readLaunchedAgentForeground')
    .mockImplementation(async (_ptyId, _agent, exact) => {
      await answered
      if (exact) {
        exact.named = name === 'claude'
      }
      return foreground
    })
}

const setLaunchNote = vi.fn()

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
        // The owner answers only after the attach's own work, as a real read over IPC does.
        let answer = (): void => {}
        const read = foregroundIs(
          runtime,
          foreground,
          name,
          new Promise((resolve) => {
            answer = resolve
          })
        )
        setLaunchNote.mockClear()
        const attached = attachWith(runtime, launchNote)
        await vi.waitFor(() => expect(read).toHaveBeenCalled())
        answer()
        await attached
        // Why no wait: a foreground check waiting on this attach must see the restored agent.
        expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe(expected)
        const retired = launchNote && foreground === 'shell'
        expect(setLaunchNote).toHaveBeenCalledTimes(retired ? 1 : 0)
      }
    )
  })

  it('drops an agent an earlier attach restored once a later reattach finds a shell', async () => {
    const runtime = survivingSession()
    foregroundIs(runtime, 'agent', 'claude')
    await attachWith(runtime, null)
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('claude')

    foregroundIs(runtime, 'shell', 'zsh')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane reattach calls this same restore.
    const internals = runtime as unknown as RuntimeInternals
    await internals.restoreReattachedLaunch(
      internals.ptysById.get(PTY_ID),
      INCARNATION_ID,
      { incarnationId: INCARNATION_ID, launchAgent: 'claude' },
      { launchNote: null }
    )
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBeNull()
  })

  it('keeps an agent an earlier attach proved when a later read proves nothing', async () => {
    const runtime = survivingSession()
    foregroundIs(runtime, 'agent', 'claude')
    await attachWith(runtime, null)
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('claude')

    const read = foregroundIs(runtime, 'unknown', null)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane reattach calls this same restore.
    const internals = runtime as unknown as RuntimeInternals
    await internals.restoreReattachedLaunch(
      internals.ptysById.get(PTY_ID),
      INCARNATION_ID,
      { incarnationId: INCARNATION_ID, launchAgent: 'claude' },
      { launchNote: null }
    )
    expect(read).toHaveBeenCalled()
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('claude')
  })
})
