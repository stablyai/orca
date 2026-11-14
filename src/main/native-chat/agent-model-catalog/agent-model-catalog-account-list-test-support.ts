import { resolveHiddenProbeCwd } from '../../lib/hidden-probe-cwd'
import { onTestFinished, vi } from 'vitest'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

export const HOME = { variable: 'CODEX_HOME', path: '/account' }
export const FOLDERS: Record<string, string> = {
  a: '/project-a',
  b: '/project-b',
  e: '/project-effort',
  r: '/restricted'
}

export const listing = (ids: string[], model?: string): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  models: ids.map((id) => ({ id, label: id, isDefault: id === ids[0], efforts: [] })),
  configured: model ? { model } : {}
})

export function record(sessionId: string, agent: 'claude' | 'codex' = 'codex'): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId,
    provider: agent,
    accountHome: HOME,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: sessionId,
      workspaceKind: 'folder'
    }
  })
}

export function harness(
  agent: 'claude' | 'codex' = 'codex',
  overrides: Partial<AgentModelCatalogServiceDeps> = {}
) {
  const full = ['gpt-a', 'gpt-b', 'gpt-c']
  const byFolder: Record<string, AgentModelCatalogSuccess> = {
    [resolveHiddenProbeCwd()]: listing(full),
    '/project-a': listing(full, 'gpt-b'),
    '/project-b': listing(full, 'gpt-c'),
    '/restricted': listing(['local-only'], 'local-only')
  }
  const gates = new Map<string, PromiseWithResolvers<void>>()
  const runs: string[] = []
  const scopeGate = Promise.withResolvers<void>()
  let holdScope = false
  const resolveScope: NonNullable<AgentModelCatalogProbe['resolve']> = async (
    _home,
    cwd,
    _lookup,
    _operation,
    launchDirectory
  ) => {
    if (holdScope) {
      await scopeGate.promise
    }
    // A project-local install resolves another CLI; every other folder shares the account's.
    const local = launchDirectory === '/restricted'
    return {
      identity: { command: local ? `./node_modules/.bin/${agent}` : agent, cwd },
      run: async () => {
        const listed = local ? '/restricted' : cwd
        runs.push(listed)
        await gates.get(listed)?.promise
        return byFolder[listed]
      }
    }
  }
  const resolve = vi.fn(resolveScope)
  // Folders a listing ran in without a resolved CLI (undefined: wherever Orca itself runs).
  const unresolvedRuns: (string | undefined)[] = []
  const probe: AgentModelCatalogProbe = Object.assign(
    async (_home: unknown, options?: { workspacePath?: string }) => {
      unresolvedRuns.push(options?.workspacePath)
      return byFolder[resolveHiddenProbeCwd()]
    },
    { resolve }
  )
  const store = overrides.store ?? new AgentModelCatalogStore({ now: () => 1000 })
  const resolveAccountHome = vi.fn<AgentModelCatalogServiceDeps['resolveAccountHome']>(
    async () => HOME
  )
  const probes = { [agent]: probe }
  const service = createAgentModelCatalogService({
    store,
    getConversation: (id) => agentSessionConversationView(record(id, agent)),
    getRecord: (id) => record(id, agent),
    drivesRecord: () => true,
    resolveAccountHome,
    recordWorkspacePath: async (saved) => FOLDERS[saved.sessionId] ?? null,
    workspaceMayOverrideDefaultModel: async () => false,
    probes,
    ...overrides
  })
  const hold = (folder: string): (() => void) => {
    const gate = Promise.withResolvers<void>()
    gates.set(folder, gate)
    return () => gate.resolve()
  }
  const read = (sessionId: string, extra = {}) => service.read({ agent, sessionId, ...extra })
  onTestFinished(() => service.stop())
  return {
    service,
    probes,
    store,
    runs,
    unresolvedRuns,
    hold,
    read,
    full,
    byFolder,
    canonicalFingerprint: agentModelCatalogScopeFingerprint(
      agentModelCatalogFingerprint({ agent, accountHome: HOME, wslDistro: null }),
      resolveHiddenProbeCwd(),
      { command: agent, cwd: resolveHiddenProbeCwd() }
    ),
    resolve,
    resolveScope,
    resolveAccountHome,
    activity: () => [resolveAccountHome.mock.calls.length, resolve.mock.calls.length, runs.length],
    holdScope: () => {
      holdScope = true
      return () => scopeGate.resolve()
    }
  }
}

export const ids = (result: Awaited<ReturnType<ReturnType<typeof harness>['read']>>) =>
  result.origin === 'unknown' ? null : result.models.map((model) => model.id)
