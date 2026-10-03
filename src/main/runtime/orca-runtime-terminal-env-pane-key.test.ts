// STA-8862: a terminal survives an Orca restart but is adopted into a tab with a new id. Its
// shell still exports the old ORCA_PANE_KEY, so every hook posts the old key. The execution host
// records that key with the process, and status follows the terminal to the pane it shows now.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE = 'repo::/tmp/env-pane-key'
const PTY = `${WORKTREE}@@surviving-shell`
const INCARNATION = '40000000-0000-4000-8000-000000000001'
const OLD_TAB = '40000000-0000-4000-8000-000000000002'
const NEW_TAB = '40000000-0000-4000-8000-000000000003'
const OLD_LEAF = '40000000-0000-4000-8000-000000000004'
const NEW_LEAF = '40000000-0000-4000-8000-000000000005'
const OLD_PANE = makePaneKey(OLD_TAB, OLD_LEAF)
const NEW_PANE = makePaneKey(NEW_TAB, NEW_LEAF)

class RestartedRuntime extends OrcaRuntimeService {
  readInventory() {
    return this.refreshPtyWorktreeRecordsWithControllerInventory([], null)
  }

  /** The renderer reattaching the surviving PTY into the tab adoption minted. */
  reattachInto(tabId: string, leafId: string): void {
    this.registerPty(PTY, WORKTREE, null, { tabId, leafId, incarnationId: INCARNATION })
  }
}

function listing(row: Partial<PtyProcessInfo> = {}): PtyProcessInfo[] {
  return [
    {
      id: PTY,
      cwd: '',
      title: 'shell',
      worktreeId: WORKTREE,
      incarnationId: INCARNATION,
      ...row
    }
  ]
}

describe('hook status follows a terminal that outlived its pane', () => {
  let dir: string
  let wiring: ReturnType<typeof makeAgentStatusStoreWiring>
  let runtime: RestartedRuntime
  let detach: () => void
  let processes: PtyProcessInfo[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-env-pane-key-'))
    wiring = makeAgentStatusStoreWiring()
    await wiring.statusStore.start({ env: 'production', userDataPath: dir })
    runtime = new RestartedRuntime(null, undefined, wiring.deps)
    processes = listing({ envPaneKey: OLD_PANE })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => processes,
      hasPty: () => true
    })
    detach = wiring.attach(runtime)
  })

  afterEach(() => {
    detach()
    wiring.statusStore.stop()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function postClaudeHook(prompt: string): void {
    // The relay path carries the same pane key the HTTP hook script reads from the PTY env.
    wiring.statusStore.ingestRemote(
      {
        paneKey: OLD_PANE,
        tabId: OLD_TAB,
        worktreeId: WORKTREE,
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt, agentType: 'claude' }
      },
      null
    )
  }

  function statusPaneKeys(): string[] {
    return wiring.statusStore.getStatusSnapshot().map((row) => row.paneKey)
  }

  it('files hooks posted under the exported key on the terminal’s current pane', async () => {
    await runtime.readInventory()
    runtime.reattachInto(NEW_TAB, NEW_LEAF)

    postClaudeHook('after the restart')

    expect(wiring.statusStore.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: NEW_PANE, tabId: NEW_TAB, prompt: 'after the restart' })
    ])
  })

  it('moves a row filed under the exported key once the terminal is reattached elsewhere', async () => {
    // Persisted before the quit, or posted before the host learned where the terminal went.
    postClaudeHook('before the restart')
    expect(statusPaneKeys()).toEqual([OLD_PANE])

    await runtime.readInventory()
    runtime.reattachInto(NEW_TAB, NEW_LEAF)

    expect(statusPaneKeys()).toEqual([NEW_PANE])
  })

  it('moves the row when the host learns the exported key after the reattach', async () => {
    postClaudeHook('before the restart')
    runtime.reattachInto(NEW_TAB, NEW_LEAF)
    expect(statusPaneKeys()).toEqual([OLD_PANE])

    await runtime.readInventory()

    expect(statusPaneKeys()).toEqual([NEW_PANE])
  })

  it('clears the moved row when the process exits and stops routing its key', async () => {
    await runtime.readInventory()
    runtime.reattachInto(NEW_TAB, NEW_LEAF)
    postClaudeHook('live')
    expect(statusPaneKeys()).toEqual([NEW_PANE])

    runtime.onPtyExit(PTY, 0, INCARNATION, { providerExitObserved: true })

    expect(statusPaneKeys()).toEqual([])
    expect(runtime.resolveAgentHookTerminalPane(OLD_PANE)).toBeUndefined()
  })

  it('clears a row left under the exported key when the process exits', async () => {
    // Inventory restores the process but no pane holds it yet, so nothing can route the post.
    await runtime.readInventory()
    postClaudeHook('never surfaced')
    expect(statusPaneKeys()).toEqual([OLD_PANE])

    runtime.onPtyExit(PTY, 0, INCARNATION, { providerExitObserved: true })

    expect(statusPaneKeys()).toEqual([])
  })

  it('stops routing once a local process exit is observed, even without a confirmed code', async () => {
    await runtime.readInventory()
    runtime.reattachInto(NEW_TAB, NEW_LEAF)
    expect(runtime.resolveAgentHookTerminalPane(OLD_PANE)).toBe(NEW_PANE)

    runtime.onPtyExit(PTY, -1, INCARNATION)

    expect(runtime.resolveAgentHookTerminalPane(OLD_PANE)).toBeUndefined()
  })

  it('routes a WSL relay post to the local terminal it came from', async () => {
    await runtime.readInventory()
    runtime.reattachInto(NEW_TAB, NEW_LEAF)

    wiring.statusStore.ingestRemote(
      {
        paneKey: OLD_PANE,
        tabId: OLD_TAB,
        worktreeId: WORKTREE,
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'from wsl', agentType: 'claude' }
      },
      'wsl:Ubuntu'
    )

    expect(statusPaneKeys()).toEqual([NEW_PANE])
  })

  it('does not route a relay post from another host onto this terminal’s pane', async () => {
    await runtime.readInventory()
    runtime.reattachInto(NEW_TAB, NEW_LEAF)

    wiring.statusStore.ingestRemote(
      {
        paneKey: OLD_PANE,
        tabId: OLD_TAB,
        worktreeId: WORKTREE,
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'other host', agentType: 'claude' }
      },
      'ssh-other'
    )

    expect(statusPaneKeys()).toEqual([OLD_PANE])
  })

  it('survives a relay row whose exported key is not a string', async () => {
    processes = listing(JSON.parse('{"envPaneKey":42}'))

    await expect(runtime.readInventory()).resolves.not.toBeNull()
    expect(runtime.resolveAgentHookTerminalPane(OLD_PANE)).toBeUndefined()
  })

  it('keeps today’s behavior with a daemon or relay that predates the field', async () => {
    processes = listing()
    await runtime.readInventory()
    runtime.reattachInto(NEW_TAB, NEW_LEAF)

    postClaudeHook('old host')

    expect(statusPaneKeys()).toEqual([OLD_PANE])
  })
})
