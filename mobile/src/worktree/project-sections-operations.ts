import { z } from 'zod'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../src/shared/mobile-project-sections-contract'
import {
  ProjectGroupSchema,
  ProjectSectionCatalogSchema,
  type ServedProjectSections
} from '../../../src/shared/project-section-catalog-schema'
import { salvagingArray } from '../../../src/shared/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import type { RpcResponse } from '../transport/types'

export type { ServedProjectSections }

export const projectSectionsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'mobileRelay.projectSections-or-skip',
    method: MOBILE_PROJECT_SECTIONS_METHOD,
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'project-sections',
      z
        .object({ catalog: ProjectSectionCatalogSchema.nullable() })
        .transform(({ catalog }) => catalog)
    )
  })
)

export const hostProjectGroupsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'projectGroup.host-groups-or-skip',
    method: 'projectGroup.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'project-groups',
      z.object({ groups: salvagingArray(ProjectGroupSchema) }).transform(({ groups }) => groups)
    )
  })
)

// Older hosts return null; transient failure retains grouping so a lost reply cannot regroup the list.
export function readServedProjectSections(
  reply: RpcResponse | null
): { kind: 'answered'; value: ServedProjectSections | null } | { kind: 'kept' } {
  if (!reply) {
    return { kind: 'kept' }
  }
  if (!reply.ok) {
    return isMobileMethodUnavailableError(reply.error.code, reply.error.message)
      ? { kind: 'answered', value: null }
      : { kind: 'kept' }
  }
  try {
    const verdict = projectSectionsRead.interpret(reply)
    return verdict.accepted ? { kind: 'answered', value: verdict.value } : { kind: 'kept' }
  } catch {
    return { kind: 'kept' }
  }
}
