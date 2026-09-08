import {
  MobileWebCreationBlankPayloadSchema,
  MobileWebCreationFromSourcePayloadSchema,
  MobileWebCreationResultSchema,
  type MobileWebCreationSelection
} from '../../../src/shared/mobile-web/workspace-creation-create-contract'
import { buildLinearWorkspaceSource } from '../../../src/shared/new-workspace/workspace-source'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileComposerCreateSelection } from '../tasks/mobile-composer-source-types'
import { normalizeWorkspaceAgent } from '../tasks/workspace-agent-selection'
import { nativeHostWorkspaceCreationOperations } from '../worktree/native-host-workspace-creation-operations'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

/** Creation stays shell-side for one reason: a workspace no catalog page has listed yet has no
 * page handle, and only the authority can mint one. Everything the page can address by host id it
 * already sends, so nothing here re-resolves what the page looked up. */
export async function executeMobileWebWorkspaceCreationCreateOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
  isRequestActive: () => boolean
}): Promise<unknown> {
  const assertActive = () => {
    if (!args.isRequestActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
  }
  const operations = nativeHostWorkspaceCreationOperations({
    ...args.client,
    getState: () => args.client.getState(),
    getLastInboundAt: () => args.client.getLastInboundAt?.() ?? null,
    onStateChange: (listener) => args.client.onStateChange(listener),
    async sendRequest(method, params, options) {
      assertActive()
      const response = await args.client.sendRequest(method, params, {
        ...options,
        beforeSend: () => {
          assertActive()
          options?.beforeSend?.()
        }
      })
      assertActive()
      return response
    }
  })
  if (args.operation === 'creationCreateBlank') {
    const payload = MobileWebCreationBlankPayloadSchema.parse(args.payload)
    const capabilities = await operations.readRuntimeCapabilities()
    const result = await operations.createBlankWorkspace({
      ...payload,
      agentChoice: requiredAgentChoice(payload.agentChoice),
      comment: payload.comment,
      worktreeCreateIdempotency: capabilities.worktreeCreateIdempotency
    })
    assertActive()
    return presentCreatedWorkspace(result, args.authority)
  }
  if (args.operation === 'creationCreateFromSource') {
    const payload = MobileWebCreationFromSourcePayloadSchema.parse(args.payload)
    const capabilities = await operations.readRuntimeCapabilities()
    const result = await operations.createWorkspaceFromSource({
      ...payload,
      selection: await hostSelection(payload.selection, operations),
      agentChoice: requiredAgentChoice(payload.agentChoice),
      workspaceName: payload.workspaceName,
      note: payload.note,
      sparseCheckout: payload.sparseCheckout,
      worktreeCreateIdempotency: capabilities.worktreeCreateIdempotency
    })
    assertActive()
    return presentCreatedWorkspace(result, args.authority)
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

/** The wire carries a Linear issue as its identifier only, so the full source is rebuilt here.
 * GitHub and GitLab items cross whole and are used as sent. */
async function hostSelection(
  selection: MobileWebCreationSelection,
  operations: ReturnType<typeof nativeHostWorkspaceCreationOperations>
): Promise<MobileComposerCreateSelection> {
  if (selection.kind !== 'work-item' || selection.item.provider !== 'linear') {
    return selection
  }
  const linearIdentifier = selection.item.linearIdentifier
  const issues = await operations.searchLinearIssues(linearIdentifier, undefined)
  const issue = issues.find(
    (candidate) => candidate.identifier.toLowerCase() === linearIdentifier.toLowerCase()
  )
  if (!issue) {
    throw new MobileWebBrokerError('not_found')
  }
  return {
    kind: 'work-item',
    item: buildLinearWorkspaceSource(issue),
    baseBranch: selection.baseBranch,
    branchNameOverride: selection.branchNameOverride
  }
}

function requiredAgentChoice(value: string) {
  const choice = normalizeWorkspaceAgent(value)
  if (!choice) {
    throw new MobileWebBrokerError('invalid_request')
  }
  return choice
}

function presentCreatedWorkspace(
  result: { worktreeId: string; name: string; warning?: string } | { error: string },
  authority: MobileWebWorkspaceAuthority
): unknown {
  if ('error' in result) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebCreationResultSchema.parse({
    workspaceId: authority.registerWorkspace(result.worktreeId),
    name: result.name,
    warning: result.warning
  })
}
