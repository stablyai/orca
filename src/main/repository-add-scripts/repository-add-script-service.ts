import { createHash, randomUUID } from 'node:crypto'
import {
  getRepoExecutionHostId,
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type {
  RepositoryAddScriptDecision,
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptExecutionResult,
  RepositoryAddScriptIdentity,
  RepositoryAddScriptOutcome,
  RepositoryAddScriptPreview,
  RepositoryAddScriptTarget
} from '../../shared/repository-add-script-types'
import { isUnsettledOutcome, ownedOutcome, settledOutcome } from './repository-add-script-outcome'
import {
  copyRepositoryAddScriptTarget,
  isSameRepositoryAddScriptTarget
} from './repository-add-script-target'

const MAX_RETAINED_INTENTS = 128
// Registration records outlive evicted intents so a used registration can never be offered again;
// they are only pruned once the repo leaves the catalog. At the cap, new previews are refused.
const MAX_REGISTRATION_RECORDS = 4096

export type RepositoryAddScriptOwner = {
  hostId: ExecutionHostId
  label: string
  available: boolean
  supported: boolean
}

export type RepositoryAddScriptRun = {
  hostId: ExecutionHostId
  repoId: string
  path: string
  target: RepositoryAddScriptTarget
  script: string
}

export type RepositoryAddScriptAuthorizationCheck = () => boolean

// Every host-scoped read takes the alias it is asked through; one service may serve several.
export type RepositoryAddScriptDependencies = {
  getOwner: (hostId: ExecutionHostId) => RepositoryAddScriptOwner | null
  getRepo: (repoId: string, hostId: ExecutionHostId) => Repo | null | undefined
  // Canonical catalog membership, independent of any alias's authority; only `false` prunes.
  repoExists: (repoId: string) => boolean
  getScript: () => string | null | undefined
  // Synchronous so the pre-spawn check can re-resolve placement; null refuses.
  resolveTarget: (repo: Repo, hostId: ExecutionHostId) => RepositoryAddScriptTarget | null
  // `isAuthorized` is synchronous so a runner can call it in the same tick as the spawn.
  runScript: (
    run: RepositoryAddScriptRun,
    isAuthorized: RepositoryAddScriptAuthorizationCheck,
    signal: AbortSignal
  ) => Promise<RepositoryAddScriptExecutionResult>
}

export type RepositoryAddScriptRegistration = {
  repo: Repo
  disposition: 'new' | 'existing' | 'linked-worktree' | 'folder-conversion'
}

type Intent = {
  preview: RepositoryAddScriptPreview
  outcome: RepositoryAddScriptOutcome
}

type RegistrationRecord = { token: string; hostId: ExecutionHostId }

type ActiveRun = { controller: AbortController; settled: Promise<unknown> }

function scriptHash(script: string): string {
  return createHash('sha256').update(script).digest('hex')
}

function isOwnerReady(
  owner: RepositoryAddScriptOwner | null,
  hostId: ExecutionHostId
): owner is RepositoryAddScriptOwner {
  return Boolean(
    owner?.available &&
    owner.supported &&
    owner.hostId === hostId &&
    parseRoutableExecutionHostId(owner.hostId)?.id === owner.hostId
  )
}

function copyPreview(preview: RepositoryAddScriptPreview): RepositoryAddScriptPreview {
  return { ...preview, target: { ...preview.target } }
}

function repoMatchesOwner(repo: Repo, owner: RepositoryAddScriptOwner): boolean {
  return (
    repo.kind !== 'folder' &&
    (!repo.executionHostId || Boolean(parseRoutableExecutionHostId(repo.executionHostId))) &&
    getRepoExecutionHostId(repo) === owner.hostId
  )
}

export class RepositoryAddScriptService {
  private readonly intents = new Map<string, Intent>()
  private readonly registrations = new Map<string, RegistrationRecord>()
  private readonly active = new Map<string, ActiveRun>()
  private closed = false

  constructor(private readonly dependencies: RepositoryAddScriptDependencies) {}

  // Only the successful registration coordinator may offer; never expose this through a run endpoint.
  offerForRegistration(
    registration: RepositoryAddScriptRegistration
  ): RepositoryAddScriptPreview | null {
    if (this.closed || registration.disposition !== 'new' || registration.repo.kind === 'folder') {
      return null
    }
    try {
      // The trusted registration projection names the host alias this offer is made through.
      const hostId = getRepoExecutionHostId(registration.repo)
      const known = this.registrations.get(registration.repo.id)
      if (known) {
        return this.reoffer(known, hostId)
      }
      const owner = this.dependencies.getOwner(hostId)
      const repo = this.dependencies.getRepo(registration.repo.id, hostId)
      const script = this.dependencies.getScript()
      if (
        !isOwnerReady(owner, hostId) ||
        !repo ||
        repo.id !== registration.repo.id ||
        repo.path !== registration.repo.path ||
        !repoMatchesOwner(repo, owner) ||
        !script?.trim()
      ) {
        return null
      }
      const target = copyRepositoryAddScriptTarget(this.dependencies.resolveTarget(repo, hostId))
      if (!target || !this.makeRegistrationRoom() || !this.makeRoom()) {
        return null
      }
      const preview: RepositoryAddScriptPreview = {
        token: randomUUID(),
        hostId,
        hostLabel: owner.label,
        repoId: repo.id,
        path: repo.path,
        target,
        script,
        scriptHash: scriptHash(script)
      }
      this.intents.set(preview.token, { preview, outcome: { status: 'pending' } })
      this.registrations.set(repo.id, { token: preview.token, hostId })
      return copyPreview(preview)
    } catch {
      return null
    }
  }

  async decide(request: RepositoryAddScriptDecision): Promise<RepositoryAddScriptDecisionResult> {
    if (request.decision !== 'run' && request.decision !== 'skip') {
      return { status: 'rejected', reason: 'invalid-decision' }
    }
    const intent = this.intents.get(request.token)
    if (!intent) {
      return { status: 'rejected', reason: 'invalid-token' }
    }
    if (intent.preview.hostId !== request.hostId || intent.preview.repoId !== request.repoId) {
      return { status: 'rejected', reason: 'identity-mismatch' }
    }
    if (intent.outcome.status !== 'pending') {
      return { status: 'rejected', reason: 'used-token' }
    }
    if (request.decision === 'skip') {
      intent.outcome = { status: 'skipped' }
      return { ...intent.outcome }
    }
    if (!this.isCurrent(intent.preview)) {
      intent.outcome = { status: 'stale' }
      return { ...intent.outcome }
    }
    // Synchronous host reads and claim prevent another decision from entering before execution.
    intent.outcome = { status: 'running' }
    const controller = new AbortController()
    const settled = this.execute(intent, controller)
    this.active.set(request.token, { controller, settled })
    await settled
    this.active.delete(request.token)
    return { ...intent.outcome }
  }

  revoke(token: string): void {
    const intent = this.intents.get(token)
    if (intent?.outcome.status === 'pending') {
      intent.outcome = { status: 'revoked' }
    }
  }

  getOutcome(identity: RepositoryAddScriptIdentity): RepositoryAddScriptOutcome | null {
    return ownedOutcome(this.intents.get(identity?.token), identity)
  }

  /**
   * Seals the service before returning: pending previews are revoked, new offers and late spawns
   * are refused, and active runs are aborted. The promise only reports when those runs settle;
   * running and unverifiable records are kept.
   */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      for (const intent of this.intents.values()) {
        if (intent.outcome.status === 'pending') {
          intent.outcome = { status: 'revoked' }
        }
      }
      for (const run of this.active.values()) {
        run.controller.abort()
      }
    }
    const runs = [...this.active.values()].map((run) => run.settled)
    return Promise.allSettled(runs).then(() => undefined)
  }

  // A settled close is not proof of exit: a running or unverifiable script may still be alive.
  hasUnsettledRuns(): boolean {
    return [...this.intents.values()].some((intent) => isUnsettledOutcome(intent.outcome))
  }

  private async execute(intent: Intent, controller: AbortController): Promise<void> {
    try {
      const { hostId, repoId, path, target, script } = intent.preview
      let blockedStale = false
      const isAuthorized = (): boolean => {
        const current =
          !this.closed &&
          !controller.signal.aborted &&
          intent.outcome.status === 'running' &&
          this.isCurrent(intent.preview)
        blockedStale ||= !current
        return current
      }
      let result: RepositoryAddScriptExecutionResult
      try {
        result = await this.dependencies.runScript(
          { hostId, repoId, path, target: { ...target }, script },
          isAuthorized,
          controller.signal
        )
      } catch (error) {
        // A runner that stopped a possibly-live process reports it as a result, never a throw.
        if (blockedStale || controller.signal.aborted) {
          intent.outcome = { status: 'stale' }
          return
        }
        throw error
      }
      intent.outcome = settledOutcome(result, controller.signal.aborted)
    } catch {
      // Errors may carry credentials or custom serializers; never inspect or return them.
      intent.outcome = { status: 'failed', reason: 'execution-failed' }
    }
  }

  // Another alias of the same registration never sees, stales or re-authorizes its intent.
  private reoffer(
    known: RegistrationRecord,
    hostId: ExecutionHostId
  ): RepositoryAddScriptPreview | null {
    const intent = this.intents.get(known.token)
    if (known.hostId !== hostId || intent?.outcome.status !== 'pending') {
      return null
    }
    if (!this.isCurrent(intent.preview)) {
      intent.outcome = { status: 'stale' }
      return null
    }
    return copyPreview(intent.preview)
  }

  private isCurrent(preview: RepositoryAddScriptPreview): boolean {
    try {
      const { hostId } = preview
      const owner = this.dependencies.getOwner(hostId)
      const repo = this.dependencies.getRepo(preview.repoId, hostId)
      const script = this.dependencies.getScript()
      return Boolean(
        isOwnerReady(owner, hostId) &&
        repo &&
        repo.id === preview.repoId &&
        repo.path === preview.path &&
        repoMatchesOwner(repo, owner) &&
        script?.trim() &&
        scriptHash(script) === preview.scriptHash &&
        isSameRepositoryAddScriptTarget(
          this.dependencies.resolveTarget(repo, hostId),
          preview.target
        )
      )
    } catch {
      return false
    }
  }

  private makeRegistrationRoom(): boolean {
    if (this.registrations.size < MAX_REGISTRATION_RECORDS) {
      return true
    }
    for (const [repoId, record] of this.registrations) {
      if (isUnsettledOutcome(this.intents.get(record.token)?.outcome)) {
        continue
      }
      try {
        // An alias refusing the repo is not absence; only the canonical catalog can say it left.
        if (this.dependencies.repoExists(repoId) === false) {
          this.registrations.delete(repoId)
        }
      } catch {
        // Unknown catalog state: keep the record.
      }
    }
    return this.registrations.size < MAX_REGISTRATION_RECORDS
  }

  private makeRoom(): boolean {
    if (this.intents.size < MAX_RETAINED_INTENTS) {
      return true
    }
    for (const [token, intent] of this.intents) {
      if (intent.outcome.status !== 'pending' && !isUnsettledOutcome(intent.outcome)) {
        this.intents.delete(token)
        return true
      }
    }
    // Only pending intents that are no longer current may be reclaimed; valid approvals never expire.
    for (const [token, intent] of this.intents) {
      if (intent.outcome.status === 'pending' && !this.isCurrent(intent.preview)) {
        intent.outcome = { status: 'stale' }
        this.intents.delete(token)
        return true
      }
    }
    return false
  }
}
