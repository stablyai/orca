import type { Repo } from '../../../../shared/repository/repo-types'
import type { NgitStatusAction, NgitWorkItem } from '../../../../shared/ngit/ngit-work-item-types'
import { getNgitViewer } from '../../../ngit/ngit-viewer'
import {
  addNgitRepoComment,
  createNgitRepoIssue,
  getNgitWorkItemDetails,
  listNgitWorkItems,
  resolveNgitPullRequestBase,
  setNgitRepoWorkItemStatus
} from '../../../ngit/repository-work-items'

export type RuntimeNgitCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => [] | [{ wslDistro?: string }]
}

export class RuntimeNgitCommands {
  constructor(private readonly deps: RuntimeNgitCommandsDeps) {}

  private async target(selector: string): Promise<[Repo, { wslDistro?: string }]> {
    const repo = await this.deps.resolveRepo(selector)
    return [repo, this.deps.getLocalGitArgs(repo)[0] ?? {}]
  }

  async listWorkItems(selector: string, force?: boolean) {
    return listNgitWorkItems(...(await this.target(selector)), { force })
  }

  async getWorkItemDetails(selector: string, eventId: string, force?: boolean) {
    return getNgitWorkItemDetails(...(await this.target(selector)), eventId, { force })
  }

  async createIssue(selector: string, title: string, body: string) {
    return createNgitRepoIssue(...(await this.target(selector)), title, body)
  }

  async addComment(selector: string, type: NgitWorkItem['type'], eventId: string, body: string) {
    return addNgitRepoComment(...(await this.target(selector)), type, eventId, body)
  }

  async setStatus(
    selector: string,
    type: NgitWorkItem['type'],
    eventId: string,
    action: NgitStatusAction
  ) {
    return setNgitRepoWorkItemStatus(...(await this.target(selector)), type, eventId, action)
  }

  async resolvePullRequestBase(selector: string, eventId: string) {
    return resolveNgitPullRequestBase(...(await this.target(selector)), eventId)
  }

  async getViewer(selector: string) {
    const [repo] = await this.target(selector)
    return getNgitViewer(repo.path)
  }
}
