import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { isOrcaSessionId } from '../../../shared/agent-session/identity/orca-session-address'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { RuntimeResolvedWorktreeCache } from '../workspaces/catalog/runtime-resolved-worktree-cache'
import type { RuntimeWorkspaceSelectors } from '../workspaces/workspace-selectors'
import { agentConversationPlaces } from './agent-conversation-list'

const hooks = vi.hoisted(() => ({
  statuses: new Map<string, { connectionId: string | null }>()
}))
vi.mock('../../agent-hooks/server/agent-hook-server', () => {
  const places = {
    terminalAgentPlaces: async () => [...hooks.statuses.keys()].map((paneKey) => ({ paneKey })),
    getPublicStatusSnapshotForPane: (paneKey: string) => {
      const status = hooks.statuses.get(paneKey)
      return status
        ? [
            {
              ...status,
              paneKey,
              worktreeId: ID,
              orcaSessionId: AGENT,
              state: 'done',
              receivedAt: 1
            }
          ]
        : []
    }
  }
  // The store's own hook-server calls are no-ops here.
  const storeCalls = Object.fromEntries(
    [
      'clearPaneKeyAliasesForPty',
      'getStatusSnapshot',
      'ingestTerminalStatus',
      'registerPaneKeyAlias',
      'setPaneKeyAliasPersistenceListener',
      'stop',
      'transferPaneAuthority'
    ].map((name) => [name, () => undefined])
  )
  return { agentHookServer: { ...storeCalls, ...places } }
})
vi.mock('electron', () => ({
  app: { getPath: () => harness.testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const harness = await import('../../persistence/persistence-test-harness')
const { RuntimeWorkspaceSelectors: Selectors } = await import('../workspaces/workspace-selectors')

const ID = 'repo-a::/srv/app'
const AGENT = 'claude_place_0001'
const SSH = 'ssh:server'

beforeEach(() => {
  harness.testState.dir = mkdtempSync(join(tmpdir(), 'orca-place-labels-'))
  hooks.statuses.clear()
})
afterEach(async () => {
  await harness.closeTestStores()
})

const local = (displayName: string): Repo =>
  harness.makeRepo({ id: 'repo-a', path: '/srv/app', displayName, executionHostId: 'local' })
const remote = (displayName: string): Repo =>
  harness.makeRepo({ id: 'repo-a', path: '/srv/app', displayName, connectionId: 'server' })

/** A real store holding `others` unrelated repos plus the same-id pair, target first or last. */
function storeWith(others: number, order: 'local first' | 'ssh first', at: 'first' | 'last') {
  const store = harness.createStore()
  const pair =
    order === 'local first'
      ? [local('Local repo'), remote('Remote repo')]
      : [remote('Remote repo'), local('Local repo')]
  const fillers = Array.from({ length: others }, (_, index) =>
    harness.makeRepo({ id: `other-${index}`, path: `/srv/other-${index}` })
  )
  for (const repo of at === 'first' ? [...pair, ...fillers] : [...fillers, ...pair]) {
    store.addRepo(repo)
  }
  store.setWorktreeMeta(hostWorktreeTarget({ id: ID, hostId: 'local' }), {
    displayName: 'Local workspace',
    displayNameIsPinned: true
  })
  store.setWorktreeMeta(hostWorktreeTarget({ id: ID, hostId: SSH }), {
    displayName: 'Remote workspace',
    displayNameIsPinned: true
  })
  return store
}

function runtimeOver(
  store: ReturnType<typeof harness.createStore>,
  cache: RuntimeResolvedWorktreeCache
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a real runtime prototype; the label and place code read only the store and catalog cache assigned here.
  const runtime = Object.create(Selectors.prototype) as RuntimeWorkspaceSelectors
  return Object.assign(runtime, {
    store,
    resolvedWorktrees: cache,
    orchestrationSenderNames: { agentRowNamer: () => () => null },
    getAgentStatusOrchestrationContextForPaneKey: () => undefined,
    getTerminalPtyIdForHandle: () => null
  })
}

async function show(runtime: ReturnType<typeof runtimeOver>, connectionId: string | null) {
  hooks.statuses.clear()
  hooks.statuses.set('pane-1', { connectionId })
  if (!isOrcaSessionId(AGENT)) {
    throw new Error('expected an Orca session id')
  }
  const places = await agentConversationPlaces(runtime, { kind: 'terminal', orcaSessionId: AGENT })
  return places.map(({ workspace, repo, hostId }) => ({ workspace, repo, hostId }))
}

const LOCAL_PLACE = { workspace: 'Local workspace', repo: 'Local repo', hostId: 'local' }
const REMOTE_PLACE = { workspace: 'Remote workspace', repo: 'Remote repo', hostId: SSH }

it.each(['local first'] as const)(
  'keeps each host its own label for one id on two hosts, %s',
  async (order) => {
    const store = storeWith(0, order, 'first')
    const runtime = runtimeOver(store, new RuntimeResolvedWorktreeCache())

    expect(await show(runtime, null)).toEqual([LOCAL_PLACE])
    expect(await show(runtime, 'wsl:Ubuntu')).toEqual([LOCAL_PLACE])
    expect(await show(runtime, 'server')).toEqual([REMOTE_PLACE])
    // A host with no registration of this repo borrows no sibling's name.
    expect(await show(runtime, 'elsewhere')).toEqual([
      { workspace: ID, repo: undefined, hostId: 'ssh:elsewhere' }
    ])
  }
)
