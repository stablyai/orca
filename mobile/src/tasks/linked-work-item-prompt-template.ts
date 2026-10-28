import type { GlobalSettings } from '../../../src/shared/global-settings-types'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import {
  getLinkedWorkItemPromptTemplate,
  normalizeLinkedWorkItemPromptTemplate
} from '../../../src/shared/linked-work-item-prompt-settings'
import type { Repo } from '../../../src/shared/repo-types'
import type { RpcClient } from '../transport/rpc-client'
import { projectSectionsRead } from '../worktree/project-sections-operations'

export async function resolveMobileLinkedWorkItemPromptTemplate(
  client: RpcClient,
  repo: Pick<Repo, 'id' | 'executionHostId' | 'connectionId'>,
  settings: Pick<GlobalSettings, 'linkedWorkItemPromptTemplate'> | null | undefined
): Promise<string | undefined> {
  try {
    const reply = await projectSectionsRead.request(client, undefined, { timeoutMs: 5_000 })
    const result = projectSectionsRead.interpret(reply)
    if (result.accepted && result.value) {
      const hostId = getRepoExecutionHostId(repo)
      const setup = result.value.setups.find(
        (candidate) => candidate.repoId === repo.id && candidate.hostId === hostId
      )
      const project = result.value.projects.find((candidate) => candidate.id === setup?.projectId)
      return getLinkedWorkItemPromptTemplate({
        settings: {
          linkedWorkItemPromptTemplate:
            normalizeLinkedWorkItemPromptTemplate(project?.linkedWorkItemPromptTemplate) ??
            settings?.linkedWorkItemPromptTemplate
        }
      })
    }
  } catch {
    // Older hosts may not serve the paired catalog; preserve their global/default draft.
  }
  return getLinkedWorkItemPromptTemplate({ settings })
}
