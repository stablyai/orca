import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { TuiAgent } from '../../shared/tui-agent'
import { makePaneKey } from '../../shared/stable-pane-id'
import { settleAgentStatusRowsAbsentFromInventory } from '../runtime/runtime-agent-status-inventory-settlement'
import { resolveAgentWorkspaceExecutionHostId } from './agent-status-pane-binding'
import { AgentHookServer } from './server'

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey(TAB, LEAF)
const PTY = 'local-repo::/wt@@pty-1'

const LOCAL_WORKTREE = 'local-repo::/wt'
const SSH_WORKTREE = 'ssh-repo::/wt'
const RUNTIME_WORKTREE = 'runtime-repo::/wt'
const SSH_TARGET = 'host-a'
const SSH_HOST_ID = toSshExecutionHostId(SSH_TARGET)

/** The ten PTY vendors that had no cleanup at all before this path existed. Typed against the
 *  real agent union so a typo fails the build instead of quietly testing a fictional vendor. */
const STRANDED_VENDORS: readonly TuiAgent[] = [
  'codex',
  'grok',
  'cursor',
  'copilot',
  'gemini',
  'opencode',
  'droid',
  'amp',
  'pi',
  'antigravity'
]

const HOST_RESOLUTION_DEPS = {
  getRepo: (repoId: string) =>
    ({
      'local-repo': { id: 'local-repo', connectionId: null, executionHostId: 'local' },
      'ssh-repo': { id: 'ssh-repo', connectionId: SSH_TARGET, executionHostId: null },
      'runtime-repo': {
        id: 'runtime-repo',
        connectionId: null,
        executionHostId: 'runtime:ephemeral-vm-1'
      }
    })[repoId],
  getWorktreeMeta: () => undefined,
  getFolderWorkspace: () => undefined,
  getProjectGroups: () => []
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-pty-inventory-settlement-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Persist a working row, then restart into a fresh server: the shape an app restart leaves
 *  behind for a pane whose PTY did not survive it. */
async function restartWithWorkingRow(options?: {
  agentType?: string
  connectionId?: string | null
  worktreeId?: string
  paneKey?: string
}): Promise<AgentHookServer> {
  const first = new AgentHookServer()
  await first.start({ env: 'production', userDataPath: dir })
  first.ingestTerminalStatus({
    paneKey: options?.paneKey ?? PANE,
    tabId: TAB,
    worktreeId: options?.worktreeId ?? LOCAL_WORKTREE,
    connectionId: options?.connectionId ?? null,
    payload: {
      state: 'working',
      prompt: 'ship the PR',
      agentType: options?.agentType ?? 'codex'
    }
  })
  first.flushStatusPersistSync()
  first.stop()

  const restarted = new AgentHookServer()
  await restarted.start({ env: 'production', userDataPath: dir })
  return restarted
}

type SettleOverrides = {
  connectionId?: string | null | undefined
  queriedHostIds?: ExecutionHostId[]
  allLivePtyIds?: string[]
  getBoundPtyId?: (paneKey: string) => string | undefined
  persistedPtyIdByPaneKey?: Record<string, string>
  livenessVerdict?: (ptyId: string) => PtyLivenessVerdict | null
  probePtyLiveness?: (ptyId: string) => boolean | null | Promise<boolean | null>
}

function settleWith(server: AgentHookServer, overrides: SettleOverrides = {}): Promise<number> {
  return settleAgentStatusRowsAbsentFromInventory(
    {
      connectionId: 'connectionId' in overrides ? overrides.connectionId : null,
      queriedHostIds: new Set(overrides.queriedHostIds ?? ['local']),
      allLivePtyIds: new Set(overrides.allLivePtyIds ?? [])
    },
    {
      listCandidates: () => server.listPtyInventorySettlementCandidates(),
      settle: (settled) => server.settlePtyInventoryAbsence(settled),
      resolveRowExecutionHostId: (candidate) =>
        resolveAgentWorkspaceExecutionHostId(candidate.worktreeId, HOST_RESOLUTION_DEPS),
      getBoundPtyIdForPaneKey: (paneKey) =>
        overrides.getBoundPtyId ? overrides.getBoundPtyId(paneKey) : PTY,
      getPersistedPtyIdForPaneKey: (paneKey) => (overrides.persistedPtyIdByPaneKey ?? {})[paneKey],
      readLivenessVerdict: (ptyId) => overrides.livenessVerdict?.(ptyId) ?? null,
      probePtyLiveness: async (ptyId) =>
        overrides.probePtyLiveness ? await overrides.probePtyLiveness(ptyId) : false
    }
  )
}

function paneState(server: AgentHookServer, paneKey = PANE): string {
  return server.getStatusSnapshotForPane(paneKey)[0]?.state ?? 'missing'
}

/** Rows the live-agent views actually render; a resume-identity remnant is filtered out. */
function visibleRows(server: AgentHookServer): string[] {
  return server
    .getStatusSnapshot()
    .filter((row) => row.providerSessionOnly !== true)
    .map((row) => row.paneKey)
}

describe('agent status settled through the host PTY inventory', () => {
  it.each(STRANDED_VENDORS)(
    'stops a %s pane reading working after a restart its PTY did not survive',
    async (agentType) => {
      const server = await restartWithWorkingRow({ agentType })
      try {
        expect(paneState(server)).toBe('working')

        expect(await settleWith(server)).toBe(1)

        expect(paneState(server)).toBe('missing')
        expect(visibleRows(server)).toEqual([])
      } finally {
        server.stop()
      }
    }
  )

  it('settles a remote pane on the relay-certified exit its own inventory cannot prove', async () => {
    const server = await restartWithWorkingRow({
      agentType: 'gemini',
      connectionId: SSH_TARGET,
      worktreeId: SSH_WORKTREE
    })
    try {
      expect(
        await settleWith(server, {
          connectionId: SSH_TARGET,
          queriedHostIds: [SSH_HOST_ID],
          // The relay's own listing omits every id minted before it restarted, so absence alone
          // is not a death certificate; the host-delivered exit frame in the register is.
          livenessVerdict: () => ({ status: 'exited' }),
          probePtyLiveness: () => null
        })
      ).toBe(1)
      expect(paneState(server)).toBe('missing')
    } finally {
      server.stop()
    }
  })

  it('leaves a remote pane alone when the relay only failed to list it', async () => {
    const server = await restartWithWorkingRow({
      agentType: 'gemini',
      connectionId: SSH_TARGET,
      worktreeId: SSH_WORKTREE
    })
    try {
      expect(
        await settleWith(server, {
          connectionId: SSH_TARGET,
          queriedHostIds: [SSH_HOST_ID],
          livenessVerdict: () => null,
          probePtyLiveness: () => null
        })
      ).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('keeps the resume identity the pane can still be restarted with', async () => {
    // Only the hook/relay ingress carries a provider session; the OSC 9999 wire has no such field.
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath: dir })
    first.ingestRemote(
      {
        paneKey: PANE,
        tabId: TAB,
        worktreeId: SSH_WORKTREE,
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        providerSession: { key: 'session_id', id: 'resume-me' },
        payload: { state: 'working', prompt: 'ship the PR', agentType: 'codex' }
      },
      SSH_TARGET
    )
    first.flushStatusPersistSync()
    first.stop()
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: dir })
    try {
      expect(paneState(server)).toBe('working')

      expect(
        await settleWith(server, {
          connectionId: SSH_TARGET,
          queriedHostIds: [SSH_HOST_ID],
          livenessVerdict: () => ({ status: 'exited' })
        })
      ).toBe(1)

      // No live claim is left to gate the pane working, but the session stays addressable.
      expect(visibleRows(server)).toEqual([])
      const remnant = server.getStatusSnapshotForPane(PANE)[0]
      expect(remnant?.providerSessionOnly).toBe(true)
      expect(remnant?.providerSession?.id).toBe('resume-me')
    } finally {
      server.stop()
    }
  })
})

describe('what the inventory settlement refuses to do', () => {
  it('does nothing for a host that was never asked', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(await settleWith(server, { queriedHostIds: [] })).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('does not stamp a local row from a per-SSH-target pass', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(
        await settleWith(server, {
          connectionId: SSH_TARGET,
          queriedHostIds: [SSH_HOST_ID, 'local']
        })
      ).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('does not let a local pass adjudicate an SSH row', async () => {
    const server = await restartWithWorkingRow({
      connectionId: SSH_TARGET,
      worktreeId: SSH_WORKTREE
    })
    try {
      expect(
        await settleWith(server, {
          connectionId: null,
          queriedHostIds: ['local', SSH_HOST_ID],
          livenessVerdict: () => ({ status: 'exited' })
        })
      ).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('never adjudicates a paired runtime host from a local listing', async () => {
    const server = await restartWithWorkingRow({ worktreeId: RUNTIME_WORKTREE })
    try {
      expect(await settleWith(server, { queriedHostIds: ['local'] })).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('treats unknown workspace provenance as no authority at all', async () => {
    const server = await restartWithWorkingRow({ worktreeId: 'vanished-repo::/wt' })
    try {
      expect(await settleWith(server)).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('does nothing when the pane names no PTY at all', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(await settleWith(server, { getBoundPtyId: () => undefined })).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('does nothing when the PTY is in the live listing', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(await settleWith(server, { allLivePtyIds: [PTY] })).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('does nothing when the probe cannot prove either state', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(await settleWith(server, { probePtyLiveness: () => null })).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('does nothing when the probe says the PTY is alive', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(await settleWith(server, { probePtyLiveness: () => true })).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('reports zero and leaves the row alone when the probe throws', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(
        await settleWith(server, {
          probePtyLiveness: () => {
            throw new Error('provider went away')
          }
        })
      ).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('falls back to the persisted binding and asks each PTY once', async () => {
    const otherLeaf = '22222222-2222-4222-8222-222222222222'
    const otherPane = makePaneKey(TAB, otherLeaf)
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath: dir })
    for (const paneKey of [PANE, otherPane]) {
      first.ingestTerminalStatus({
        paneKey,
        tabId: TAB,
        worktreeId: LOCAL_WORKTREE,
        connectionId: null,
        payload: { state: 'working', prompt: 'ship the PR', agentType: 'codex' }
      })
    }
    first.flushStatusPersistSync()
    first.stop()
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: dir })
    const probe = vi.fn(() => false)
    try {
      expect(
        await settleWith(server, {
          getBoundPtyId: () => undefined,
          persistedPtyIdByPaneKey: { [PANE]: PTY, [otherPane]: PTY },
          probePtyLiveness: probe
        })
      ).toBe(2)
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      server.stop()
    }
  })
})

describe('the three fences the deleted startup reaper carried', () => {
  it('fence 1: never settles a pane that has reported to this runtime', async () => {
    const server = await restartWithWorkingRow()
    try {
      // A live producer for this pane: the inventory is not part of that conversation.
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: TAB,
        worktreeId: LOCAL_WORKTREE,
        connectionId: null,
        payload: { state: 'working', prompt: 'ship the PR', agentType: 'codex' }
      })

      expect(server.listPtyInventorySettlementCandidates()).toEqual([])
      expect(await settleWith(server)).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('fence 1 again: a pane that starts reporting while the probe is in flight survives', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(
        await settleWith(server, {
          probePtyLiveness: () => {
            server.ingestTerminalStatus({
              paneKey: PANE,
              tabId: TAB,
              worktreeId: LOCAL_WORKTREE,
              connectionId: null,
              payload: { state: 'working', prompt: 'ship the PR', agentType: 'codex' }
            })
            return false
          }
        })
      ).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('fence 2: a candidate naming a different turn than the row on file is refused', async () => {
    const server = await restartWithWorkingRow()
    try {
      const [candidate] = server.listPtyInventorySettlementCandidates()
      expect(candidate).toBeDefined()
      // This pane never reported to this runtime, so fence 1 is not what refuses these — the
      // identity is. A verdict in flight holds exactly this kind of snapshot.
      expect(
        server.settlePtyInventoryAbsence([
          { ...candidate!, stateStartedAt: candidate!.stateStartedAt - 1 }
        ])
      ).toBe(0)
      expect(paneState(server)).toBe('working')

      // The row moved on after the candidate was read.
      expect(
        server.settlePtyInventoryAbsence([
          { ...candidate!, receivedAt: candidate!.receivedAt - 1 }
        ])
      ).toBe(0)
      expect(paneState(server)).toBe('working')

      // Positive control: the same call with the identity it actually read does settle.
      expect(server.settlePtyInventoryAbsence([candidate!])).toBe(1)
      expect(paneState(server)).toBe('missing')
    } finally {
      server.stop()
    }
  })

  it('fences 1 and 2 together: a live turn arriving after the read abandons the settle', async () => {
    const server = await restartWithWorkingRow()
    try {
      const candidates = server.listPtyInventorySettlementCandidates()
      expect(candidates).toHaveLength(1)

      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: TAB,
        worktreeId: LOCAL_WORKTREE,
        connectionId: null,
        payload: { state: 'blocked', prompt: 'ship the PR', agentType: 'codex' }
      })

      expect(server.settlePtyInventoryAbsence(candidates)).toBe(0)
      expect(paneState(server)).toBe('blocked')
    } finally {
      server.stop()
    }
  })

  it('fence 3: a pane that rebinds a newer PTY while the probe is in flight survives', async () => {
    const server = await restartWithWorkingRow()
    let bound = PTY
    try {
      expect(
        await settleWith(server, {
          getBoundPtyId: (paneKey) => (paneKey === PANE ? bound : undefined),
          probePtyLiveness: () => {
            // Cold restore respawned this pane against a new process mid-probe.
            bound = 'local-repo::/wt@@pty-2'
            return false
          }
        })
      ).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('settles once the same pane stops rebinding, so the fences defer rather than strand', async () => {
    const server = await restartWithWorkingRow()
    try {
      expect(await settleWith(server, { probePtyLiveness: () => false })).toBe(1)
      expect(paneState(server)).toBe('missing')
    } finally {
      server.stop()
    }
  })
})
