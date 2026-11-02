import type { Repo } from '../../shared/repo-types'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'

type LocalGitArgs = [] | [{ wslDistro?: string }]

export type RuntimeGiteaCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export abstract class RuntimeGiteaCommandBase {
  constructor(protected readonly deps: RuntimeGiteaCommandsDeps) {}

  protected async repo(selector: string): Promise<Repo> {
    return this.deps.resolveRepo(selector)
  }

  protected gitOptions(repo: Repo): { wslDistro?: string } {
    return this.deps.getLocalGitArgs(repo)[0] ?? {}
  }

  protected reviewOptions(repo: Repo): HostedReviewExecutionOptions {
    const wslDistro = this.gitOptions(repo).wslDistro
    return wslDistro ? { localGitExecOptions: { wslDistro } } : {}
  }
}
