import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'

// A swallowed Enter used to look exactly like a successful send: the caller got `accepted: true`
// while the instruction sat unsubmitted in the composer. These cover the verdict that tells the
// two apart, and the retry rule that must never re-type the text.

const WORKTREE_ID = 'repo-1::/tmp/verdict-worktree'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PTY_ID = 'pty-verdict'
const VERDICT_BOUND_MS = 20

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/verdict-worktree',
        displayName: 'verdict',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

async function makeRuntime(): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  paneKey: string
  write: ReturnType<typeof vi.fn>
}> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const write = vi.fn(() => true)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => []),
    hasPty: () => true
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Claude',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  const handle = terminals[0].handle
  const paneKey = runtime.getTerminalPaneKey(handle)
  if (!paneKey) {
    throw new Error('expected a stable pane key for the test terminal')
  }
  return { runtime, handle, paneKey, write }
}

function noteIdleClaude(runtime: OrcaRuntimeService, paneKey: string): void {
  runtime.noteAgentSubmitHookEvent({
    paneKey,
    source: 'claude',
    hookEventName: 'Stop',
    state: 'done'
  })
}

function noteClaudeTurnStart(runtime: OrcaRuntimeService, paneKey: string): void {
  runtime.noteAgentSubmitHookEvent({
    paneKey,
    source: 'claude',
    hookEventName: 'UserPromptSubmit',
    hasExplicitPrompt: true,
    state: 'working'
  })
}

function writtenPayloads(write: ReturnType<typeof vi.fn>): string[] {
  return write.mock.calls.map((call) => String(call[1]))
}

describe('terminal send submit verdict', () => {
  it('reports submitted when the harness starts a turn with the text', async () => {
    const { runtime, handle, paneKey, write } = await makeRuntime()
    noteIdleClaude(runtime, paneKey)

    const pending = runtime.sendTerminal(
      handle,
      { text: 'ship it', enter: true },
      { submitVerdict: { timeoutMs: VERDICT_BOUND_MS } }
    )
    noteClaudeTurnStart(runtime, paneKey)
    const result = await pending

    expect(result).toMatchObject({ accepted: true })
    expect(result.submitVerdict).toMatchObject({
      status: 'submitted',
      reason: 'turn-start-observed'
    })
    expect(result.submitVerdict?.resubmitted).toBeUndefined()
    expect(writtenPayloads(write)).toEqual(['ship it', '\r'])
  })

  it('reports pending and retries the submit only, never the text', async () => {
    const { runtime, handle, paneKey, write } = await makeRuntime()
    noteIdleClaude(runtime, paneKey)

    const result = await runtime.sendTerminal(
      handle,
      { text: 'ship it', enter: true },
      { submitVerdict: { timeoutMs: VERDICT_BOUND_MS } }
    )

    expect(result.submitVerdict).toMatchObject({
      status: 'pending',
      reason: 'no-turn-start-observed',
      resubmitted: true
    })
    // Why: a re-typed payload after a partly accepted line becomes a doubled message.
    expect(writtenPayloads(write)).toEqual(['ship it', '\r', '\r'])
    expect(writtenPayloads(write).filter((payload) => payload === 'ship it')).toHaveLength(1)
  })

  it('resolves the retry to submitted when the second Enter takes', async () => {
    const { runtime, handle, paneKey, write } = await makeRuntime()
    noteIdleClaude(runtime, paneKey)
    write.mockImplementation((_ptyId: string, payload: string) => {
      // Why: models the completion popup that eats the first Enter and the second that submits.
      if (payload === '\r' && writtenPayloads(write).filter((p) => p === '\r').length === 2) {
        noteClaudeTurnStart(runtime, paneKey)
      }
      return true
    })

    const result = await runtime.sendTerminal(
      handle,
      { text: 'ship it', enter: true },
      { submitVerdict: { timeoutMs: VERDICT_BOUND_MS } }
    )

    expect(result.submitVerdict).toMatchObject({ status: 'submitted', resubmitted: true })
    expect(writtenPayloads(write)).toEqual(['ship it', '\r', '\r'])
  })

  it('reports unknown without retrying when nothing proves the harness reports turns', async () => {
    const { runtime, handle, write } = await makeRuntime()

    const result = await runtime.sendTerminal(
      handle,
      { text: 'ship it', enter: true },
      { submitVerdict: { timeoutMs: VERDICT_BOUND_MS } }
    )

    expect(result.submitVerdict).toMatchObject({
      status: 'unknown',
      reason: 'no-live-hook-evidence'
    })
    // Why: unknown is not a failure to recover from — re-submitting on it would type into a pane
    // whose state we cannot read at all.
    expect(writtenPayloads(write)).toEqual(['ship it', '\r'])
  })

  it('honours retrySubmit: false on a pending verdict', async () => {
    const { runtime, handle, paneKey, write } = await makeRuntime()
    noteIdleClaude(runtime, paneKey)

    const result = await runtime.sendTerminal(
      handle,
      { text: 'ship it', enter: true },
      { submitVerdict: { timeoutMs: VERDICT_BOUND_MS, retrySubmit: false } }
    )

    expect(result.submitVerdict).toMatchObject({ status: 'pending' })
    expect(result.submitVerdict?.resubmitted).toBeUndefined()
    expect(writtenPayloads(write)).toEqual(['ship it', '\r'])
  })

  it('omits the verdict when the caller does not ask for one', async () => {
    const { runtime, handle, paneKey } = await makeRuntime()
    noteIdleClaude(runtime, paneKey)

    const result = await runtime.sendTerminal(handle, { text: 'ship it', enter: true })

    expect(result.submitVerdict).toBeUndefined()
  })

  it('omits the verdict for a write that carries no submit', async () => {
    const { runtime, handle, paneKey } = await makeRuntime()
    noteIdleClaude(runtime, paneKey)

    const result = await runtime.sendTerminal(
      handle,
      { text: 'half a thought' },
      { submitVerdict: { timeoutMs: VERDICT_BOUND_MS } }
    )

    expect(result.submitVerdict).toBeUndefined()
  })

  it('reports the verdict for an agent prompt send', async () => {
    const { runtime, handle, paneKey } = await makeRuntime()
    noteIdleClaude(runtime, paneKey)

    const pending = runtime.sendTerminalAgentPrompt(handle, 'do the thing', {
      submitVerdict: { timeoutMs: VERDICT_BOUND_MS }
    })
    noteClaudeTurnStart(runtime, paneKey)

    expect((await pending).submitVerdict).toMatchObject({ status: 'submitted' })
  })

  it('retries only the submit key for an agent prompt send', async () => {
    const { runtime, handle, paneKey, write } = await makeRuntime()
    noteIdleClaude(runtime, paneKey)

    const result = await runtime.sendTerminalAgentPrompt(handle, 'do the thing', {
      submitVerdict: { timeoutMs: VERDICT_BOUND_MS }
    })

    expect(result.submitVerdict).toMatchObject({ status: 'pending', resubmitted: true })
    const payloads = writtenPayloads(write)
    expect(payloads.filter((payload) => payload.includes('do the thing'))).toHaveLength(1)
    expect(payloads.at(-1)).toBe('\r')
  })
})
