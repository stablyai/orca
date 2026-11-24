import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { WORKTREE_CATALOG_METHODS } from '../../rpc/methods/workspaces/worktree-catalog-methods'
import type { RuntimeWorktreePsSummary } from '../../../../shared/worktree/catalog/runtime-worktree-contracts'
import type { RuntimeAgentLineageCatalogTestModule } from '../../../../shared/worktree/catalog/runtime-agent-lineage-consumer.test-fixture'

export function createLineageCatalogDispatcher(build: () => RuntimeWorktreePsSummary) {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('lineage-test')
  vi.spyOn(runtime, 'getWorktreePs').mockImplementation(async () => ({
    worktrees: [build()],
    totalCount: 1,
    truncated: false
  }))
  return new RpcDispatcher({ runtime, methods: WORKTREE_CATALOG_METHODS })
}

export default { createLineageCatalogDispatcher } satisfies RuntimeAgentLineageCatalogTestModule
