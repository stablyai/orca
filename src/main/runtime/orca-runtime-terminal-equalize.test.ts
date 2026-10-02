import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/workspace`
const TAB_ID = 'tab-1'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE_PTY_ID = 'pty-source'

type RuntimeTestInternals = {
  issueHandle: (leaf: unknown) => string
  issuePtyHandle: (pty: unknown) => string
  leaves: Map<string, unknown>
  ptysById: Map<string, { connected: boolean }>
}

function getInternals(service: OrcaRuntimeService): RuntimeTestInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test suite accesses internal handle generation and registry collections.
  return service as never
}

function createHarness(options: { graphOnly?: boolean; connected?: boolean } = {}) {
  const repo = {
    id: REPO_ID,
    path: '/workspace',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    persistPtyBinding: () => true
  }
  const equalizeTerminal = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test stub provides only the repository and workspace session store operations accessed by the runtime.
  const runtime = new OrcaRuntimeService(store as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test stub implements only the PTY controller methods exercised during runtime lifecycle.
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: vi.fn(),
    retireRejectedPty: vi.fn(),
    getForegroundProcess: async () => null
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test stub provides only the equalizeTerminal notifier callback exercised in this suite.
  runtime.setNotifier({ equalizeTerminal } as never)

  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal Tab',
        activeLeafId: SOURCE_LEAF_ID,
        layout: { type: 'leaf', leafId: SOURCE_LEAF_ID }
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: SOURCE_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: SOURCE_PTY_ID
      }
    ]
  })

  const internals = getInternals(runtime)
  if (!options.graphOnly) {
    runtime.registerPty(SOURCE_PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: SOURCE_LEAF_ID
    })
    if (options.connected === false) {
      const ptyRecord = internals.ptysById.get(SOURCE_PTY_ID)
      if (ptyRecord) {
        ptyRecord.connected = false
      }
    }
  }

  const handle = options.graphOnly
    ? internals.issueHandle([...internals.leaves.values()][0])
    : internals.issuePtyHandle(internals.ptysById.get(SOURCE_PTY_ID))

  return {
    runtime,
    handle,
    equalizeTerminal
  }
}

describe('runtime equalizeTerminal', () => {
  it('equalizes a PTY-backed terminal by notifying the renderer with tabId', async () => {
    const harness = createHarness()

    const result = await harness.runtime.equalizeTerminal(harness.handle)

    expect(result).toEqual({
      handle: harness.handle,
      tabId: TAB_ID
    })
    expect(harness.equalizeTerminal).toHaveBeenCalledWith(TAB_ID)
  })

  it('equalizes a graph-only leaf terminal by notifying the renderer with tabId', async () => {
    const harness = createHarness({ graphOnly: true })

    const result = await harness.runtime.equalizeTerminal(harness.handle)

    expect(result).toEqual({
      handle: harness.handle,
      tabId: TAB_ID
    })
    expect(harness.equalizeTerminal).toHaveBeenCalledWith(TAB_ID)
  })

  it('throws terminal_exited when the PTY is disconnected', async () => {
    const harness = createHarness({ connected: false })

    await expect(harness.runtime.equalizeTerminal(harness.handle)).rejects.toThrow(
      'terminal_exited'
    )
    expect(harness.equalizeTerminal).not.toHaveBeenCalled()
  })

  it('throws terminal_handle_stale for an unknown handle', async () => {
    const harness = createHarness()

    await expect(harness.runtime.equalizeTerminal('term_nonexistent')).rejects.toThrow(
      'terminal_handle_stale'
    )
    expect(harness.equalizeTerminal).not.toHaveBeenCalled()
  })
})
