import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSubagentSnapshot } from '../../shared/agent-status-types'
import { isLocalExecutionHost } from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'
import {
  indexPersistedPaneKeyPtyIds,
  resolveAgentWorkspaceExecutionHostId,
  retireRestoredStatusesWithDeadTerminals
} from './restored-status-dead-terminal-sweep'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const OTHER_PANE = makePaneKey('tab-2', LEAF)
const PTY = 'wt-1__pty-1'
const WORKING_CHILD: AgentSubagentSnapshot = {
  id: 'areview-loop-c237a4c577493352',
  state: 'working',
  startedAt: 1_000
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-restored-status-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

type PersistedRow = {
  paneKey?: string
  agentType?: string
  state?: 'working' | 'waiting' | 'blocked' | 'done'
  connectionId?: string | null
  subagents?: AgentSubagentSnapshot[]
  providerSessionOnly?: boolean
}

async function restartWith(rows: PersistedRow[] = [{}]): Promise<AgentHookServer> {
  const now = Date.now()
  const entries = Object.fromEntries(
    rows.map((row) => {
      const paneKey = row.paneKey ?? PANE
      return [
        paneKey,
        {
          paneKey,
          tabId: paneKey.split(':')[0],
          worktreeId: 'wt-1',
          connectionId: row.connectionId ?? null,
          providerSession: { key: 'session_id', id: `resume-${paneKey}` },
          ...(row.providerSessionOnly
            ? { providerSessionOnly: true, retainedForLiveness: true }
            : {}),
          payload: {
            state: row.state ?? 'working',
            prompt: 'review the PR',
            agentType: row.agentType ?? 'claude',
            ...(row.subagents ? { subagents: row.subagents } : {})
          },
          receivedAt: now,
          stateStartedAt: now
        }
      ]
    })
  )
  mkdirSync(join(dir, 'agent-hooks'), { recursive: true })
  writeFileSync(
    join(dir, 'agent-hooks', 'last-status.json'),
    JSON.stringify({ version: 2, entries, authorityCommitments: {} })
  )
  const server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
  return server
}

function sweepWith(
  server: AgentHookServer,
  overrides: {
    probePtyLiveness?: (ptyId: string) => boolean | null | Promise<boolean | null>
    executionHostId?: string | null
    boundPtyIdByPaneKey?: Record<string, string>
    persistedPtyIdByPaneKey?: Record<string, string>
  } = {}
): Promise<number> {
  return retireRestoredStatusesWithDeadTerminals({
    server,
    probePtyLiveness: async (ptyId) =>
      overrides.probePtyLiveness ? await overrides.probePtyLiveness(ptyId) : false,
    isLocalExecutionHost: () =>
      isLocalExecutionHost(
        overrides.executionHostId === undefined ? 'local' : overrides.executionHostId
      ),
    getBoundPtyIdForPaneKey: (paneKey) => overrides.boundPtyIdByPaneKey?.[paneKey],
    getPersistedPtyIdForPaneKey: (paneKey) =>
      (overrides.persistedPtyIdByPaneKey ?? { [PANE]: PTY })[paneKey]
  })
}

function paneState(server: AgentHookServer, paneKey = PANE): string {
  const entry = server.getStatusSnapshotForPane(paneKey)[0]
  return entry && !entry.providerSessionOnly ? entry.state : 'missing'
}

function deferredProbe(): {
  probePtyLiveness: ReturnType<typeof vi.fn<(ptyId: string) => Promise<boolean | null>>>
  resolve: (live: boolean | null) => void
} {
  let resolve!: (live: boolean | null) => void
  const probePtyLiveness = vi.fn(
    () =>
      new Promise<boolean | null>((settle) => {
        resolve = settle
      })
  )
  return { probePtyLiveness, resolve: (live) => resolve(live) }
}

describe('restored status dead-terminal sweep', () => {
  it.each(['codex', 'omp', 'claude'])(
    'retires a restored working %s row whose terminal is gone, keeping it resumable',
    async (agentType) => {
      const server = await restartWith([{ agentType }])
      try {
        expect(server.getStatusSnapshotForPane(PANE)[0]?.restoredUnconfirmed).toBe(true)

        expect(await sweepWith(server)).toBe(1)

        expect(paneState(server)).toBe('missing')
        expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
          providerSessionOnly: true,
          providerSession: { id: `resume-${PANE}` }
        })
      } finally {
        server.stop()
      }
    }
  )

  it('retires a WSL pane, whose PTY lives in the local provider', async () => {
    const server = await restartWith([{ connectionId: 'wsl:Ubuntu' }])
    try {
      expect(await sweepWith(server)).toBe(1)

      expect(paneState(server)).toBe('missing')
    } finally {
      server.stop()
    }
  })

  it('retires a Claude pane held open by restored subagents so a later turn there settles', async () => {
    const server = await restartWith([{ subagents: [WORKING_CHILD] }])
    try {
      expect(await sweepWith(server)).toBe(1)
      expect(paneState(server)).toBe('missing')

      for (const hook_event_name of ['UserPromptSubmit', 'Stop']) {
        const response = await postHookEvent(
          server,
          buildBody(
            { hook_event_name, session_id: 'next-session', prompt: 'next task' },
            { paneKey: PANE }
          )
        )
        expect(response.status).toBe(204)
      }

      // A stranded restored child could keep the next finished turn working.
      expect(paneState(server)).toBe('done')
    } finally {
      server.stop()
    }
  })

  it('never treats a hydrated resume remnant as a candidate', async () => {
    const server = await restartWith([{ agentType: 'codex', providerSessionOnly: true }])
    const probePtyLiveness = vi.fn(() => false)
    try {
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
        providerSessionOnly: true,
        state: 'working'
      })

      expect(await sweepWith(server, { probePtyLiveness })).toBe(0)

      expect(probePtyLiveness).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it.each(['waiting', 'blocked'] as const)(
    'retires a restored %s row rather than inventing a completion',
    async (state) => {
      const server = await restartWith([{ state }])
      try {
        expect(await sweepWith(server)).toBe(1)

        expect(paneState(server)).toBe('missing')
      } finally {
        server.stop()
      }
    }
  )

  it('probes a PTY bound in this runtime before the persisted one, once per PTY', async () => {
    const server = await restartWith([{}, { paneKey: OTHER_PANE }])
    const probePtyLiveness = vi.fn(() => false)
    try {
      expect(
        await sweepWith(server, {
          probePtyLiveness,
          boundPtyIdByPaneKey: { [PANE]: PTY, [OTHER_PANE]: PTY },
          persistedPtyIdByPaneKey: { [PANE]: 'stale', [OTHER_PANE]: 'stale' }
        })
      ).toBe(2)

      expect(probePtyLiveness).toHaveBeenCalledExactlyOnceWith(PTY)
    } finally {
      server.stop()
    }
  })

  it.each([
    ['is live', () => true],
    ['cannot be proven either way', () => null],
    [
      'throws',
      () => {
        throw new Error('daemon unreachable')
      }
    ]
  ])('keeps the row when the PTY probe %s', async (_label, probePtyLiveness) => {
    const server = await restartWith([{ agentType: 'codex' }])
    try {
      expect(await sweepWith(server, { probePtyLiveness })).toBe(0)

      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('keeps a pane with no PTY binding to probe', async () => {
    const server = await restartWith([{ agentType: 'codex' }])
    const probePtyLiveness = vi.fn(() => false)
    try {
      expect(await sweepWith(server, { probePtyLiveness, persistedPtyIdByPaneKey: {} })).toBe(0)

      expect(probePtyLiveness).not.toHaveBeenCalled()
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('never retires an SSH relay row, whose PTY is not in the local provider', async () => {
    const server = await restartWith([{ agentType: 'codex', connectionId: 'conn-1' }])
    const probePtyLiveness = vi.fn(() => false)
    try {
      expect(await sweepWith(server, { probePtyLiveness })).toBe(0)

      expect(probePtyLiveness).not.toHaveBeenCalled()
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it.each([
    ['an SSH', 'ssh:conn-1', toAppSshPtyId('conn-1', PTY)],
    ['a paired runtime', 'runtime:ephemeral-vm-1', 'remote:ephemeral-vm-1@@pty-1']
  ])('never retires a row in %s workspace', async (_label, executionHostId, ptyId) => {
    const server = await restartWith([{ agentType: 'codex' }])
    const probePtyLiveness = vi.fn(() => false)
    try {
      expect(
        await sweepWith(server, {
          executionHostId,
          probePtyLiveness,
          persistedPtyIdByPaneKey: { [PANE]: ptyId }
        })
      ).toBe(0)

      expect(probePtyLiveness).not.toHaveBeenCalled()
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('leaves a restored done row alone', async () => {
    const server = await restartWith([{ agentType: 'codex', state: 'done' }])
    const probePtyLiveness = vi.fn(() => false)
    try {
      expect(await sweepWith(server, { probePtyLiveness })).toBe(0)

      expect(probePtyLiveness).not.toHaveBeenCalled()
      expect(paneState(server)).toBe('done')
    } finally {
      server.stop()
    }
  })

  it('skips a pane that has reported to this runtime', async () => {
    const server = await restartWith([{ agentType: 'codex' }])
    const probePtyLiveness = vi.fn(() => false)
    try {
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'round two', agentType: 'codex' }
      })

      expect(await sweepWith(server, { probePtyLiveness })).toBe(0)

      expect(probePtyLiveness).not.toHaveBeenCalled()
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it('keeps a pane that reports while its probe is pending', async () => {
    const server = await restartWith([{ agentType: 'codex' }])
    const probe = deferredProbe()
    try {
      const sweep = sweepWith(server, { probePtyLiveness: probe.probePtyLiveness })
      await vi.waitFor(() => expect(probe.probePtyLiveness).toHaveBeenCalledOnce())
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'confirmed during probe', agentType: 'codex' }
      })
      probe.resolve(false)

      expect(await sweep).toBe(0)
      expect(paneState(server)).toBe('working')
    } finally {
      server.stop()
    }
  })

  it.each([
    ['binds a newer PTY', { [PANE]: PTY }, 'wt-1__pty-new'],
    ['rebinds its persisted PTY', {}, PTY]
  ])(
    'keeps a pane that %s while its probe is pending',
    async (_label, initialBinding: Record<string, string>, reboundPtyId) => {
      const server = await restartWith([{ agentType: 'codex' }])
      const boundPtyIdByPaneKey = { ...initialBinding }
      const probe = deferredProbe()
      try {
        const sweep = sweepWith(server, {
          probePtyLiveness: probe.probePtyLiveness,
          boundPtyIdByPaneKey
        })
        await vi.waitFor(() => expect(probe.probePtyLiveness).toHaveBeenCalledExactlyOnceWith(PTY))
        boundPtyIdByPaneKey[PANE] = reboundPtyId
        probe.resolve(false)

        expect(await sweep).toBe(0)
        expect(paneState(server)).toBe('working')
      } finally {
        server.stop()
      }
    }
  )

  it('keeps a rebind that lands after its own probe but before the batch settles', async () => {
    const otherPty = 'wt-1__pty-2'
    const server = await restartWith([{}, { paneKey: OTHER_PANE }])
    const boundPtyIdByPaneKey: Record<string, string> = {}
    const probe = deferredProbe()
    const probePtyLiveness = vi.fn((ptyId: string) =>
      ptyId === PTY ? Promise.resolve(false) : probe.probePtyLiveness(ptyId)
    )
    try {
      const sweep = sweepWith(server, {
        probePtyLiveness,
        boundPtyIdByPaneKey,
        persistedPtyIdByPaneKey: { [PANE]: PTY, [OTHER_PANE]: otherPty }
      })
      await vi.waitFor(() => expect(probePtyLiveness).toHaveBeenCalledTimes(2))
      boundPtyIdByPaneKey[PANE] = PTY
      probe.resolve(false)

      expect(await sweep).toBe(1)
      expect(paneState(server)).toBe('working')
      expect(paneState(server, OTHER_PANE)).toBe('missing')
    } finally {
      server.stop()
    }
  })
})

describe('indexPersistedPaneKeyPtyIds', () => {
  it('maps layout leaves to pane keys and ignores empty bindings', () => {
    expect(
      indexPersistedPaneKeyPtyIds({
        'tab-1': { ptyIdsByLeafId: { [LEAF]: PTY, 'leaf-empty': '' } },
        'tab-2': undefined,
        'tab-3': {}
      })
    ).toEqual(new Map([[PANE, PTY]]))
  })
})

describe('resolveAgentWorkspaceExecutionHostId', () => {
  const localRepo = {
    id: 'local-repo',
    connectionId: null,
    executionHostId: 'local' as const
  }
  const runtimeRepo = {
    id: 'runtime-repo',
    connectionId: null,
    executionHostId: 'runtime:ephemeral-vm-1' as const
  }
  const futureHostRepo = {
    id: 'future-repo',
    connectionId: null,
    executionHostId: 'container:future-host'
  }
  const deps = {
    getRepo: (repoId: string) =>
      [localRepo, runtimeRepo, futureHostRepo].find((candidate) => candidate.id === repoId),
    getWorktreeMeta: (worktreeId: string) => {
      if (worktreeId === 'local-repo::/runtime-worktree') {
        return { hostId: 'runtime:worktree-owner' }
      }
      if (worktreeId === 'runtime-repo::/local-worktree') {
        return { hostId: 'local' }
      }
      if (worktreeId === 'local-repo::/future-worktree') {
        return { hostId: 'container:future-host' }
      }
      return undefined
    },
    getFolderWorkspace: (id: string) =>
      id === 'folder-runtime' ? { projectGroupId: 'group-runtime', connectionId: null } : undefined,
    getProjectGroups: () => [
      {
        id: 'group-runtime',
        connectionId: null,
        executionHostId: 'runtime:ephemeral-vm-1'
      }
    ]
  }

  it('positively identifies local ownership and rejects runtime hosts', () => {
    expect(resolveAgentWorkspaceExecutionHostId('local-repo::/repo', deps)).toBe('local')
    expect(resolveAgentWorkspaceExecutionHostId('runtime-repo::/repo', deps)).toBe(
      'runtime:ephemeral-vm-1'
    )
    expect(resolveAgentWorkspaceExecutionHostId('folder:folder-runtime', deps)).toBe(
      'runtime:ephemeral-vm-1'
    )
    expect(resolveAgentWorkspaceExecutionHostId('local-repo::/runtime-worktree', deps)).toBe(
      'runtime:worktree-owner'
    )
    expect(resolveAgentWorkspaceExecutionHostId('runtime-repo::/local-worktree', deps)).toBe(
      'local'
    )
    expect(resolveAgentWorkspaceExecutionHostId('future-repo::/repo', deps)).toBeNull()
    expect(resolveAgentWorkspaceExecutionHostId('local-repo::/future-worktree', deps)).toBeNull()
    expect(isLocalExecutionHost('local')).toBe(true)
    expect(isLocalExecutionHost('runtime:ephemeral-vm-1')).toBe(false)
  })

  it('treats missing workspace provenance as unknown', () => {
    expect(resolveAgentWorkspaceExecutionHostId('missing::/repo', deps)).toBeNull()
    expect(resolveAgentWorkspaceExecutionHostId(undefined, deps)).toBeNull()
    expect(isLocalExecutionHost(null)).toBe(false)
  })
})
