import {
  MobileWebTaskGitHubDetailPayloadSchema,
  MobileWebTaskGitHubDetailResultSchema,
  MobileWebTaskGitHubLabelsPayloadSchema,
  MobileWebTaskGitHubLabelsResultSchema,
  MobileWebTaskGitHubUsersPayloadSchema,
  MobileWebTaskGitHubUsersResultSchema,
  MobileWebTaskGitLabDetailPayloadSchema,
  MobileWebTaskGitLabDetailResultSchema,
  MobileWebTaskLinearDetailPayloadSchema,
  MobileWebTaskLinearDetailResultSchema
} from '../../../src/shared/mobile-web/task-detail-contract'
import {
  MobileWebTaskBootstrapPayloadSchema,
  MobileWebTaskBootstrapResultSchema,
  MobileWebTaskLinearContextPayloadSchema,
  MobileWebTaskLinearContextResultSchema,
  MobileWebTaskPreferenceUpdateResultSchema,
  MobileWebTaskRepoPayloadSchema,
  MobileWebTaskRepositoriesPayloadSchema,
  MobileWebTaskRepositoriesResultSchema,
  MobileWebTaskRepoSlugResultSchema,
  MobileWebTaskResumeUpdatePayloadSchema,
  MobileWebTaskSettingsUpdatePayloadSchema
} from '../../../src/shared/mobile-web/task-read-contract'
import {
  MobileWebTaskGitHubCountPayloadSchema,
  MobileWebTaskGitHubCountResultSchema,
  MobileWebTaskGitHubListPayloadSchema,
  MobileWebTaskGitHubListResultSchema,
  MobileWebTaskGitLabListPayloadSchema,
  MobileWebTaskGitLabListResultSchema,
  MobileWebTaskGitLabTodosPayloadSchema,
  MobileWebTaskGitLabTodosResultSchema,
  MobileWebTaskLinearListPayloadSchema,
  MobileWebTaskLinearListResultSchema
} from '../../../src/shared/mobile-web/task-list-contract'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { HostTaskRepository } from '../tasks/host-task-read-operations'
import { nativeHostTaskDetailOperations } from '../tasks/native-host-task-detail-operations'
import { nativeHostTaskListOperations } from '../tasks/native-host-task-list-operations'
import { nativeHostTaskReadOperations } from '../tasks/native-host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import { mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebTaskSettings } from './mobile-web-task-bootstrap-projection'
import type { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'
import type { MobileWebTaskProjectTablePager } from './mobile-web-task-project-table-pager'
import { pageLinearIssue } from './mobile-web-task-linear-projection'
import { executeMobileWebTaskProjectOperation } from './mobile-web-task-project-operations'
import { executeMobileWebTaskWriteOperation } from './mobile-web-task-write-operations'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebTaskReadOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
  targetAuthority: MobileWebTaskTargetAuthority
  projectTable: MobileWebTaskProjectTablePager
}): Promise<unknown> {
  const operations = nativeHostTaskReadOperations(args.client)
  if (args.operation === 'repositories') {
    MobileWebTaskRepositoriesPayloadSchema.parse(args.payload)
    return pageRepositories(await operations.listRepositories(), args.authority)
  }
  if (args.operation === 'bootstrap') {
    MobileWebTaskBootstrapPayloadSchema.parse(args.payload)
    const repositories = await operations.listRepositories()
    args.authority.synchronizeCreationRepositories(repositories)
    const bootstrap = await operations.bootstrap()
    return MobileWebTaskBootstrapResultSchema.parse({
      ...bootstrap,
      settings: mobileWebTaskSettings(
        bootstrap.settings,
        (repoId) => pageRepoId(repoId, args.authority)[0] ?? null
      ),
      trustedOrcaHooks: pageTrust(bootstrap.trustedOrcaHooks, args.authority)
    })
  }
  if (args.operation === 'linearContext') {
    MobileWebTaskLinearContextPayloadSchema.parse(args.payload)
    return MobileWebTaskLinearContextResultSchema.parse(await operations.loadLinearContext())
  }
  if (args.operation === 'resolveRepoSlug') {
    const payload = MobileWebTaskRepoPayloadSchema.parse(args.payload)
    const repository = await operations.resolveGitHubRepoSlug(
      args.authority.hostRepoId(payload.repoId)
    )
    return MobileWebTaskRepoSlugResultSchema.parse({ repository })
  }
  if (args.operation === 'updateResume') {
    const payload = MobileWebTaskResumeUpdatePayloadSchema.parse(args.payload)
    requireSuccess(
      await args.client.sendRequest('ui.set', {
        taskResumeState: payload.taskResumeState
      })
    )
    return MobileWebTaskPreferenceUpdateResultSchema.parse(null)
  }
  if (args.operation === 'updateSettings') {
    const payload = MobileWebTaskSettingsUpdatePayloadSchema.parse(args.payload)
    requireSuccess(
      await args.client.sendRequest('settings.update', {
        ...payload,
        ...(payload.defaultRepoSelection !== undefined
          ? {
              defaultRepoSelection:
                payload.defaultRepoSelection === null
                  ? null
                  : payload.defaultRepoSelection.map((repoId) => args.authority.hostRepoId(repoId))
            }
          : {})
      })
    )
    return MobileWebTaskPreferenceUpdateResultSchema.parse(null)
  }
  const listOperations = nativeHostTaskListOperations(args.client)
  if (args.operation === 'listGitHub') {
    const payload = MobileWebTaskGitHubListPayloadSchema.parse(args.payload)
    const repoId = args.authority.hostRepoId(payload.repoId)
    const result = await listOperations.listGitHub({ ...payload, repoId })
    return MobileWebTaskGitHubListResultSchema.parse({
      items: result.items.map((item) => ({
        ...item,
        targetId: args.targetAuthority.registerGitHub({
          repoId,
          number: item.number,
          type: item.type
        })
      })),
      sources: result.sources
        ? {
            issues: result.sources.issues,
            prs: result.sources.prs,
            upstreamCandidate: result.sources.upstreamCandidate
          }
        : undefined,
      errors: result.errors?.issues
        ? { issues: { message: result.errors.issues.message } }
        : undefined,
      issueSourceFellBack: result.issueSourceFellBack
    })
  }
  if (args.operation === 'countGitHub') {
    const payload = MobileWebTaskGitHubCountPayloadSchema.parse(args.payload)
    return MobileWebTaskGitHubCountResultSchema.parse({
      count: await listOperations.countGitHub({
        ...payload,
        repoId: args.authority.hostRepoId(payload.repoId)
      })
    })
  }
  if (args.operation === 'listGitLab') {
    const payload = MobileWebTaskGitLabListPayloadSchema.parse(args.payload)
    const repoId = args.authority.hostRepoId(payload.repoId)
    const result = await listOperations.listGitLab({ ...payload, repoId })
    return MobileWebTaskGitLabListResultSchema.parse({
      ...result,
      items: result.items.map((item) => {
        const rawItem = item as typeof item & {
          projectRef?: { host: string; path: string }
        }
        return {
          ...rawItem,
          projectRef: undefined,
          targetId: args.targetAuthority.registerGitLab({
            repoId,
            number: rawItem.number,
            type: rawItem.type,
            projectRef: rawItem.projectRef
          })
        }
      })
    })
  }
  if (args.operation === 'listGitLabTodos') {
    const payload = MobileWebTaskGitLabTodosPayloadSchema.parse(args.payload)
    return MobileWebTaskGitLabTodosResultSchema.parse({
      items: await listOperations.listGitLabTodos(args.authority.hostRepoId(payload.repoId))
    })
  }
  if (args.operation === 'listLinear') {
    const payload = MobileWebTaskLinearListPayloadSchema.parse(args.payload)
    return MobileWebTaskLinearListResultSchema.parse({
      items: (await listOperations.listLinear(payload)).map((item) =>
        pageLinearIssue(item, args.targetAuthority)
      )
    })
  }
  const detailOperations = nativeHostTaskDetailOperations(args.client)
  if (args.operation === 'listGitHubLabels') {
    const payload = MobileWebTaskGitHubLabelsPayloadSchema.parse(args.payload)
    return MobileWebTaskGitHubLabelsResultSchema.parse({
      labels: await detailOperations.listGitHubLabels(args.authority.hostRepoId(payload.repoId))
    })
  }
  if (args.operation === 'listGitHubAssignableUsers') {
    const payload = MobileWebTaskGitHubUsersPayloadSchema.parse(args.payload)
    return MobileWebTaskGitHubUsersResultSchema.parse({
      users: await detailOperations.listGitHubAssignableUsers(
        args.authority.hostRepoId(payload.repoId)
      )
    })
  }
  if (args.operation === 'loadGitHubDetail') {
    const payload = MobileWebTaskGitHubDetailPayloadSchema.parse(args.payload)
    return MobileWebTaskGitHubDetailResultSchema.parse(
      await detailOperations.loadGitHub({
        ...payload,
        repoId: args.authority.hostRepoId(payload.repoId)
      })
    )
  }
  if (args.operation === 'loadGitLabDetail') {
    const payload = MobileWebTaskGitLabDetailPayloadSchema.parse(args.payload)
    const target = args.targetAuthority.resolveGitLab(payload.targetId)
    return MobileWebTaskGitLabDetailResultSchema.parse(await detailOperations.loadGitLab(target))
  }
  if (args.operation === 'loadLinearDetail') {
    const payload = MobileWebTaskLinearDetailPayloadSchema.parse(args.payload)
    const target = args.targetAuthority.resolveLinear(payload.targetId)
    const result = await detailOperations.loadLinear(target)
    return MobileWebTaskLinearDetailResultSchema.parse({
      ...result,
      issue: pageLinearIssue(result.issue, args.targetAuthority)
    })
  }
  const write = await executeMobileWebTaskWriteOperation({
    operation: args.operation,
    payload: args.payload,
    client: args.client,
    targetAuthority: args.targetAuthority,
    workspaceAuthority: args.authority
  })
  if (write.handled) {
    return write.result
  }
  return executeMobileWebTaskProjectOperation({
    operation: args.operation,
    payload: args.payload,
    client: args.client,
    table: args.projectTable,
    targetAuthority: args.targetAuthority
  })
}

function pageRepositories(
  repositories: HostTaskRepository[],
  authority: MobileWebWorkspaceAuthority
): unknown {
  authority.synchronizeCreationRepositories(repositories)
  return MobileWebTaskRepositoriesResultSchema.parse({
    repositories: repositories.map((repository) => {
      const id = authority.pageRepoId(repository.id)
      return {
        id,
        displayName: repository.displayName,
        path: repository.path,
        badgeColor: repository.badgeColor,
        kind: repository.kind,
        connectionId: repository.connectionId ? id : null,
        issueSourcePreference: repository.issueSourcePreference
      }
    })
  })
}

function pageTrust(
  trust: PersistedTrustedOrcaHooks,
  authority: MobileWebWorkspaceAuthority
): PersistedTrustedOrcaHooks {
  return Object.fromEntries(
    Object.entries(trust).flatMap(([hostRepoId, entry]) => {
      const ids = pageRepoId(hostRepoId, authority)
      return ids.map((id) => [id, entry])
    })
  )
}

function pageRepoId(hostRepoId: string, authority: MobileWebWorkspaceAuthority): string[] {
  try {
    return [authority.pageRepoId(hostRepoId)]
  } catch {
    return []
  }
}

function requireSuccess(response: { ok: boolean; error?: { code?: unknown } }): void {
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error ?? {})
  }
}
