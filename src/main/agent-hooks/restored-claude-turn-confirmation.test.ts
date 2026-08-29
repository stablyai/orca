import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  confirmRestoredWorkingClaudeTurns,
  readClaudeTurnLifecycle,
  type RestoredClaudeTurnConfirmationDeps
} from './restored-claude-turn-confirmation'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

const NOW = 1_800_000_000_000
/** The turn boundary the shared lifecycle decoder reports for a generation still running. */
const OPEN_TURN: NativeChatTurnLifecycle = {
  state: 'working',
  turnId: 't1',
  timestamp: NOW - 5_000
}
const ENDED_TURN: NativeChatTurnLifecycle = {
  state: 'completed',
  turnId: 't1',
  timestamp: NOW - 5_000
}

/** A hydrated `working` Claude row as `getStatusSnapshot()` reports it. */
function statusRow(paneKey: string, transcriptPath: string): AgentStatusIpcPayload {
  return {
    paneKey,
    worktreeId: 'wt-1',
    connectionId: null,
    state: 'working',
    agentType: 'claude',
    restoredUnconfirmed: true,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: { key: 'session_id', id: 'sess-1', transcriptPath }
  } as AgentStatusIpcPayload
}

function makeDeps(
  overrides: Partial<RestoredClaudeTurnConfirmationDeps> = {}
): RestoredClaudeTurnConfirmationDeps & { confirm: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn().mockReturnValue(true)
  return {
    getStatusSnapshot: () => [statusRow('tab-1:leaf-1', '/tmp/session.jsonl')],
    isLocalExecutionHost: () => true,
    getBoundPtyIdForPaneKey: () => 'pty-1',
    getPersistedPtyIdForPaneKey: () => undefined,
    readForegroundProcess: async () => 'claude',
    toReadableTranscriptPath: async (path: string) => path,
    readTurnLifecycle: async () => OPEN_TURN,
    now: () => NOW,
    confirm,
    ...overrides
  } as RestoredClaudeTurnConfirmationDeps & { confirm: ReturnType<typeof vi.fn> }
}

describe('confirmRestoredWorkingClaudeTurns', () => {
  it('confirms a pane still running Claude whose transcript shows the turn open', async () => {
    const deps = makeDeps()

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(1)
    expect(deps.confirm).toHaveBeenCalledWith('tab-1:leaf-1')
  })

  it('leaves the row alone when the transcript shows the turn ended while Orca was down', async () => {
    const deps = makeDeps({
      readTurnLifecycle: async () => ENDED_TURN
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it("refuses a row whose hooks arrived over a relay — that is a remote pane's verdict", async () => {
    const rows = [{ ...statusRow('tab-1:leaf-1', '/tmp/a.jsonl'), connectionId: 'conn-1' }]
    const readForegroundProcess = vi.fn()
    const deps = makeDeps({ getStatusSnapshot: () => rows, readForegroundProcess })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(readForegroundProcess).not.toHaveBeenCalled()
  })

  it('allows a WSL relay row when its workspace execution host is local', async () => {
    const rows = [
      {
        ...statusRow('tab-1:leaf-1', '/home/dev/session.jsonl'),
        connectionId: wslHookRelayConnectionId('Ubuntu')
      }
    ]
    const toReadableTranscriptPath = vi.fn(async (path: string) => path)
    const deps = makeDeps({ getStatusSnapshot: () => rows, toReadableTranscriptPath })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(1)
    expect(deps.confirm).toHaveBeenCalledWith('tab-1:leaf-1')
    expect(toReadableTranscriptPath).toHaveBeenCalledWith(
      '/home/dev/session.jsonl',
      expect.any(AbortSignal),
      'Ubuntu'
    )
  })

  it('refuses an open boundary older than a plausible tool call', async () => {
    // Why: an abandoned mid-turn transcript stays open forever, so pairing one with a Claude that
    // happens to run in the pane now would confirm a session that died days ago. Measured: real
    // open boundaries in the wild are either under an hour old or 25h+.
    const stale = makeDeps({
      readTurnLifecycle: async () => ({ ...OPEN_TURN, timestamp: NOW - 13 * 60 * 60 * 1000 })
    })
    await expect(confirmRestoredWorkingClaudeTurns(stale)).resolves.toBe(0)
    expect(stale.confirm).not.toHaveBeenCalled()

    // A long-but-plausible turn still confirms — that is the case this feature exists for.
    const long = makeDeps({
      readTurnLifecycle: async () => ({ ...OPEN_TURN, timestamp: NOW - 3 * 60 * 60 * 1000 })
    })
    await expect(confirmRestoredWorkingClaudeTurns(long)).resolves.toBe(1)

    // A boundary with no timestamp proves no age, so it cannot clear the bound.
    const undated = makeDeps({
      readTurnLifecycle: async () => ({ ...OPEN_TURN, timestamp: null })
    })
    await expect(confirmRestoredWorkingClaudeTurns(undated)).resolves.toBe(0)

    const future = makeDeps({
      readTurnLifecycle: async () => ({ ...OPEN_TURN, timestamp: NOW + 1 })
    })
    await expect(confirmRestoredWorkingClaudeTurns(future)).resolves.toBe(0)
    expect(future.confirm).not.toHaveBeenCalled()
  })

  it('refuses a turn with no boundary in the window — absence is not evidence of work', async () => {
    // Why refused rather than assumed open: a confirmed row holds a wake lock and leaves the
    // dead-pane sweep, and a quiet pane emits no hook to correct the guess.
    const deps = makeDeps({ readTurnLifecycle: async () => undefined })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('confirms a pane that reattaches to the inspected PTY mid-pass — that is not a rebind', async () => {
    // Why this is the common case: reconciliation is chained off the same localPtyReady promise
    // that gates pty:spawn, so restored panes bind while the pass is inspecting them. Comparing
    // against the probe-time binding instead of the inspected id drops exactly these panes.
    let bound: string | undefined = undefined
    const deps = makeDeps({
      getBoundPtyIdForPaneKey: () => bound,
      getPersistedPtyIdForPaneKey: () => 'pty-1',
      readForegroundProcess: async () => {
        bound = 'pty-1'
        return 'claude'
      }
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(1)
    expect(deps.confirm).toHaveBeenCalledWith('tab-1:leaf-1')
  })

  it('refuses a pane rebound after its evidence was gathered', async () => {
    let bound: string | undefined = 'pty-1'
    const deps = makeDeps({
      getBoundPtyIdForPaneKey: () => bound,
      toReadableTranscriptPath: async (path: string) => {
        bound = 'pty-2'
        return path
      }
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('refuses a pane detached after its evidence was gathered', async () => {
    let bound: string | undefined = 'pty-1'
    const deps = makeDeps({
      getBoundPtyIdForPaneKey: () => bound,
      toReadableTranscriptPath: async (path: string) => {
        bound = undefined
        return path
      }
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('refuses an initially unbound pane that attaches and then detaches mid-pass', async () => {
    let bound: string | undefined
    const deps = makeDeps({
      getBoundPtyIdForPaneKey: () => bound,
      getPersistedPtyIdForPaneKey: () => 'pty-1',
      readForegroundProcess: async () => {
        bound = 'pty-1'
        return 'claude'
      },
      toReadableTranscriptPath: async (path: string) => {
        bound = undefined
        return path
      }
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('never confirms a remote pane, whose agent and transcript live on the execution host', async () => {
    const readForegroundProcess = vi.fn()
    const deps = makeDeps({ isLocalExecutionHost: () => false, readForegroundProcess })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('refuses a pane whose agent is gone — the shell keeps the PTY alive after Claude dies', async () => {
    for (const foreground of ['bash', 'zsh', null]) {
      const deps = makeDeps({ readForegroundProcess: async () => foreground })
      await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
      expect(deps.confirm).not.toHaveBeenCalled()
    }
  })

  it('refuses a pane now running a different agent than the row claims', async () => {
    const deps = makeDeps({ readForegroundProcess: async () => 'codex' })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('refuses a pane rebound to another PTY while the inspection was in flight', async () => {
    let bound = 'pty-1'
    const deps = makeDeps({
      getBoundPtyIdForPaneKey: () => bound,
      readForegroundProcess: async () => {
        bound = 'pty-2'
        return 'claude'
      }
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('falls back to the persisted PTY for a pane that has not reattached yet', async () => {
    const readForegroundProcess = vi.fn().mockResolvedValue('claude')
    const deps = makeDeps({
      getBoundPtyIdForPaneKey: () => undefined,
      getPersistedPtyIdForPaneKey: () => 'pty-persisted',
      readForegroundProcess
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(1)
    expect(readForegroundProcess).toHaveBeenCalledWith('pty-persisted')
  })

  it('skips a pane with no PTY at all', async () => {
    const deps = makeDeps({
      getBoundPtyIdForPaneKey: () => undefined,
      getPersistedPtyIdForPaneKey: () => undefined
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('reads the transcript through the host-readable path, and skips when it has none', async () => {
    const uncPath = '\\\\wsl.localhost\\Ubuntu\\home\\n\\session.jsonl'
    const readTurnLifecycle = vi.fn().mockResolvedValue(OPEN_TURN)
    const translated = makeDeps({
      toReadableTranscriptPath: async () => uncPath,
      readTurnLifecycle
    })
    await expect(confirmRestoredWorkingClaudeTurns(translated)).resolves.toBe(1)
    // Why the signal too: WSL reads go through a two-slot gate, so the pass must stay cancellable.
    expect(readTurnLifecycle).toHaveBeenCalledWith(uncPath, expect.any(AbortSignal))

    const unreadable = makeDeps({ toReadableTranscriptPath: async () => null })
    await expect(confirmRestoredWorkingClaudeTurns(unreadable)).resolves.toBe(0)
    expect(unreadable.confirm).not.toHaveBeenCalled()
  })

  it('skips rows that are not hydrated working Claude turns', async () => {
    const rows: AgentStatusIpcPayload[] = [
      { ...statusRow('tab-1:leaf-1', '/tmp/a.jsonl'), restoredUnconfirmed: false },
      { ...statusRow('tab-1:leaf-2', '/tmp/b.jsonl'), state: 'done' },
      { ...statusRow('tab-1:leaf-3', '/tmp/c.jsonl'), agentType: 'codex' },
      { ...statusRow('tab-1:leaf-4', '/tmp/d.jsonl'), providerSessionOnly: true },
      { ...statusRow('tab-1:leaf-5', '/tmp/e.jsonl'), providerSession: undefined }
    ]
    const readForegroundProcess = vi.fn()
    const deps = makeDeps({ getStatusSnapshot: () => rows, readForegroundProcess })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(readForegroundProcess).not.toHaveBeenCalled()
  })

  it('one unreadable transcript cannot strand the panes behind it', async () => {
    const readTurnLifecycle = vi
      .fn()
      .mockRejectedValueOnce(new Error('unreadable'))
      .mockResolvedValue(OPEN_TURN)
    const deps = makeDeps({
      getStatusSnapshot: () => [
        statusRow('tab-1:leaf-1', '/tmp/a.jsonl'),
        statusRow('tab-1:leaf-2', '/tmp/b.jsonl')
      ],
      readTurnLifecycle
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(1)
    expect(deps.confirm).toHaveBeenCalledWith('tab-1:leaf-2')
  })

  it('inspects each shared PTY once', async () => {
    const readForegroundProcess = vi.fn().mockResolvedValue('claude')
    const deps = makeDeps({
      getStatusSnapshot: () => [
        statusRow('tab-1:leaf-1', '/tmp/a.jsonl'),
        statusRow('tab-1:leaf-2', '/tmp/b.jsonl')
      ],
      readForegroundProcess
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(2)
    expect(readForegroundProcess).toHaveBeenCalledTimes(1)
  })

  it('bounds concurrent eligible-row inspection and eventually confirms every row', async () => {
    const rows = Array.from({ length: 80 }, (_, index) =>
      statusRow(`tab-${index}:leaf-1`, `/tmp/${index}.jsonl`)
    )
    let active = 0
    let maxActive = 0
    const readForegroundProcess = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return 'claude'
    })
    const deps = makeDeps({
      getStatusSnapshot: () => rows,
      getBoundPtyIdForPaneKey: (paneKey) => paneKey,
      readForegroundProcess
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(rows.length)
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(readForegroundProcess).toHaveBeenCalledTimes(rows.length)
  })

  it('refuses an interrupted turn — the notice ends the generation it lands in', async () => {
    const deps = makeDeps({
      readTurnLifecycle: async () => ({ ...OPEN_TURN, state: 'interrupted' as const })
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it("keeps one pane's unresolvable workspace from stranding the others", async () => {
    // Why outside the transcript read: the host and binding lookups run before it, and
    // `Promise.all` would reject the whole pass on the first throw.
    const deps = makeDeps({
      getStatusSnapshot: () => [
        statusRow('tab-1:leaf-1', '/tmp/a.jsonl'),
        statusRow('tab-1:leaf-2', '/tmp/b.jsonl')
      ],
      isLocalExecutionHost: (worktreeId) => {
        if (worktreeId === 'wt-1') {
          throw new Error('workspace record missing')
        }
        return true
      }
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
  })

  it('does no work when nothing is awaiting confirmation', async () => {
    const readForegroundProcess = vi.fn()
    const deps = makeDeps({ getStatusSnapshot: () => [], readForegroundProcess })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(readForegroundProcess).not.toHaveBeenCalled()
  })

  it('does no provider or transcript work for a large irrelevant snapshot', async () => {
    const rows = Array.from({ length: 4_097 }, (_, index) => ({
      ...statusRow(`tab-${index}:leaf-1`, `/tmp/${index}.jsonl`),
      agentType: 'codex' as const
    }))
    const readForegroundProcess = vi.fn(async () => 'claude')
    const toReadableTranscriptPath = vi.fn(async (path: string) => path)
    const deps = makeDeps({
      getStatusSnapshot: () => rows,
      readForegroundProcess,
      toReadableTranscriptPath
    })

    await expect(confirmRestoredWorkingClaudeTurns(deps)).resolves.toBe(0)
    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(toReadableTranscriptPath).not.toHaveBeenCalled()
    expect(deps.confirm).not.toHaveBeenCalled()
  })
})

describe('readClaudeTurnLifecycle', () => {
  it('reads the newest boundary out of a real transcript file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-turn-lifecycle-'))
    try {
      const path = join(dir, 'session.jsonl')
      const stamp = new Date(NOW).toISOString()
      writeFileSync(
        path,
        [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            timestamp: stamp,
            message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }] }
          }),
          // Why these two: a tool call in flight and the harness noise that follows it must both
          // leave the opening prompt as the newest boundary.
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            timestamp: stamp,
            message: {
              role: 'assistant',
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]
            }
          }),
          JSON.stringify({
            type: 'user',
            uuid: 'u2',
            timestamp: stamp,
            message: {
              role: 'user',
              content: [
                { type: 'text', text: '<local-command-stdout>saved</local-command-stdout>' }
              ]
            }
          }),
          ''
        ].join('\n')
      )

      const lifecycle = await readClaudeTurnLifecycle(path)

      expect(lifecycle?.state).toBe('working')
      expect(lifecycle?.timestamp).toBe(NOW)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
