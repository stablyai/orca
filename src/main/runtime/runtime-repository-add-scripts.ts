import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  RepositoryAddScriptDecision,
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptIdentity,
  RepositoryAddScriptOutcome,
  RepositoryAddScriptPreview
} from '../../shared/repository-add-script-types'
import type { NewGitRepositoryObserver } from '../repository-add-scripts/new-git-repository-observer'
import {
  createRepositoryAddScriptHostAuthority,
  type RepositoryAddScriptHostAuthority,
  type RepositoryAddScriptHostAuthorityOptions
} from '../repository-add-scripts/repository-add-script-host-authority'
import { createRepositoryAddScriptRunner } from '../repository-add-scripts/repository-add-script-runner'
import { RepositoryAddScriptService } from '../repository-add-scripts/repository-add-script-service'

export type RepositoryAddScriptCollector = {
  // Pass only as one registration request's new-Git-repository observer; it is the only way to offer.
  onNewGitRepository: NewGitRepositoryObserver
  previews: () => RepositoryAddScriptPreview[]
}

/** The one add-script service of this catalog; every window, RPC client and alias shares it. */
export class RuntimeRepositoryAddScripts {
  private readonly authority: RepositoryAddScriptHostAuthority
  private readonly service: RepositoryAddScriptService

  constructor(options: RepositoryAddScriptHostAuthorityOptions) {
    const authority = createRepositoryAddScriptHostAuthority(options)
    this.authority = authority
    this.service = new RepositoryAddScriptService({
      getOwner: authority.getOwner,
      getRepo: authority.getRepo,
      repoExists: authority.repoExists,
      getScript: authority.getScript,
      resolveTarget: authority.resolveTarget,
      // A runner per run keeps the run's own alias as the executor instead of binding the first one.
      runScript: (run, isAuthorized, signal) =>
        createRepositoryAddScriptRunner({
          getExecutorHostId: () => authority.requireExecutorHostId(run.hostId),
          getRuntime: (current) => authority.requireRunRuntime(current)
        })(run, isAuthorized, signal)
    })
  }

  createCollector(hostId: ExecutionHostId): RepositoryAddScriptCollector {
    const previews = new Map<string, RepositoryAddScriptPreview>()
    return {
      onNewGitRepository: (repo) => {
        const registered = this.authority.getRegistrationRepo(repo, hostId)
        const preview =
          registered && this.service.offerForRegistration({ repo: registered, disposition: 'new' })
        if (preview) {
          previews.set(preview.repoId, preview)
        }
      },
      previews: () => [...previews.values()]
    }
  }

  decide(request: RepositoryAddScriptDecision): Promise<RepositoryAddScriptDecisionResult> {
    return this.service.decide(request)
  }

  getOutcome(identity: RepositoryAddScriptIdentity): RepositoryAddScriptOutcome | null {
    return this.service.getOutcome(identity)
  }

  close(): Promise<void> {
    return this.service.close()
  }

  hasUnsettledRuns(): boolean {
    return this.service.hasUnsettledRuns()
  }
}
