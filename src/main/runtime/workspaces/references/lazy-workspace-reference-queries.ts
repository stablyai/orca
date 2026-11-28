import type { RuntimeReferenceFindParams } from '../../../../shared/workspace-attachments/runtime-reference-contracts'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkspaceReferenceQueries } from '../../runtime-workspace-reference-queries'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'

type WorkspaceReferenceQuerySources = ConstructorParameters<typeof WorkspaceReferenceQueries>[0]

export type LazyWorkspaceReferenceHost = {
  runtime: OrcaRuntimeService
  store: WorkspaceReferenceQuerySources['store']
  cachedWorktrees: WorkspaceReferenceQuerySources['cachedWorktrees']
  scanWorktrees: WorkspaceReferenceQuerySources['scanWorktrees']
  resolveRepo: WorkspaceReferenceQuerySources['resolveRepo']
  getOrchestrationDbIfAvailable: () => OrchestrationDb | null
  openAgentSessionRecordStore: () => Promise<AgentSessionRecordStore>
  listRepos: () => ReturnType<OrcaRuntimeService['listRepos']>
}

export function createLazyWorkspaceReferenceQueries(host: LazyWorkspaceReferenceHost) {
  let cached: Promise<WorkspaceReferenceQueries> | null = null
  const load = (): Promise<WorkspaceReferenceQueries> => {
    if (!cached) {
      cached = Promise.all([
        import('../../runtime-workspace-reference-queries'),
        import('./runtime-reference-agents'),
        import('../../orchestration/addressing/session-lineage/structured-session-lineage')
      ])
        .then(
          ([
            { WorkspaceReferenceQueries },
            { createReferenceAgentIndex, referenceConnectionHosts },
            { conversationRecordReader }
          ]) =>
            new WorkspaceReferenceQueries({
              store: host.store,
              cachedWorktrees: host.cachedWorktrees,
              scanWorktrees: host.scanWorktrees,
              resolveRepo: host.resolveRepo,
              agents: async (workspaceKeys) =>
                createReferenceAgentIndex(
                  host.runtime,
                  host.getOrchestrationDbIfAvailable(),
                  conversationRecordReader(await host.openAgentSessionRecordStore()),
                  workspaceKeys,
                  referenceConnectionHosts(host.listRepos())
                )
            })
        )
        .catch((error) => {
          cached = null
          throw error
        })
    }
    return cached
  }
  return {
    list: async (selector: string, cwd?: string) => (await load()).list(selector, cwd),
    find: async (params: RuntimeReferenceFindParams) => (await load()).find(params)
  }
}
