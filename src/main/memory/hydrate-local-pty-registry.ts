import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { splitWorktreeId, worktreeIdComparisonKey } from '../../shared/worktree/id'
import { getDaemonProvider } from '../daemon/daemon-init'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import type { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import type { SessionInfo } from '../daemon/types'
import { isFolderWorkspaceIdForRepo } from '../ipc/worktrees/folder-workspace-model'
import type { Store } from '../persistence'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { listLocalRepoWorktreesStrict } from '../repo-worktrees'
import { listRegisteredPtys, registerPty } from './pty-registry'

type HydrationStore = Store

type DaemonInventory = {
  complete: boolean
  sessions: SessionInfo[]
}

type LocalRepoCatalog = {
  byId: Map<string, Repo>
  ownerCountById: Map<string, number>
}

// Why: matches existing local Git/read startup budgets while allowing for Defender-heavy repos.
export const LOCAL_PTY_REGISTRY_BOOT_HYDRATION_DEADLINE_MS = 5_000
export const LOCAL_PTY_REGISTRY_GIT_ENUMERATION_CONCURRENCY = 4

let hasHydrated = false
let hydrationInFlight: Promise<void> | null = null

export function hydrateLocalPtyRegistryAtBoot(store: HydrationStore): Promise<void> {
  if (hasHydrated) {
    return Promise.resolve()
  }
  if (hydrationInFlight) {
    return hydrationInFlight
  }

  const controller = new AbortController()
  const deadline = setTimeout(() => {
    controller.abort(new Error('Boot-time pty-registry hydration deadline expired'))
  }, LOCAL_PTY_REGISTRY_BOOT_HYDRATION_DEADLINE_MS)
  let attempt!: Promise<void>
  attempt = waitForPromiseWithSignal(
    hydrateLocalPtyRegistry(store, controller.signal),
    controller.signal
  )
    .then((complete) => {
      if (complete) {
        hasHydrated = true
      }
    })
    .catch((error) => {
      console.warn(
        '[memory] Boot-time pty-registry hydration failed:',
        error instanceof Error ? error.message : String(error)
      )
    })
    .finally(() => {
      clearTimeout(deadline)
      if (hydrationInFlight === attempt) {
        hydrationInFlight = null
      }
    })
  hydrationInFlight = attempt
  return attempt
}

async function hydrateLocalPtyRegistry(
  store: HydrationStore,
  signal: AbortSignal
): Promise<boolean> {
  throwIfSignalAborted(signal)
  const provider = getDaemonProvider()
  if (!provider) {
    return false
  }

  const repoCatalog = getLocalRepoCatalog(store.getRepos())
  const reposById = repoCatalog.byId
  const verifiedFolderWorktreeIds = getVerifiedFolderWorktreeIds(store, repoCatalog)
  const liveGitWorktreeIdsByKey = new Map<string, string | null>()
  const resolvedRepoIds = new Set<string>()
  let inventory = await collectSessionInfos(provider, signal)
  let complete = inventory.complete
  let alreadyRegistered = new Set(listRegisteredPtys().map((pty) => pty.ptyId))

  for (;;) {
    const referencedRepos = new Map<string, Repo>()
    for (const info of inventory.sessions) {
      if (alreadyRegistered.has(info.sessionId)) {
        continue
      }
      const parsed = splitWorktreeId(parsePtySessionId(info.sessionId).worktreeId ?? '')
      if (!parsed || resolvedRepoIds.has(parsed.repoId)) {
        continue
      }
      const repo = reposById.get(parsed.repoId)
      if (!repo || isFolderRepo(repo)) {
        resolvedRepoIds.add(parsed.repoId)
        continue
      }
      referencedRepos.set(repo.id, repo)
    }
    if (referencedRepos.size === 0) {
      break
    }
    for (const repo of referencedRepos.values()) {
      resolvedRepoIds.add(repo.id)
    }

    const worktreeResults = await mapSettledWithConcurrency(
      [...referencedRepos.values()],
      LOCAL_PTY_REGISTRY_GIT_ENUMERATION_CONCURRENCY,
      async (repo) => {
        throwIfSignalAborted(signal)
        const worktrees = await waitForPromiseWithSignal(
          listLocalRepoWorktreesStrict(repo, {
            ...getLocalProjectWorktreeGitOptions(store, repo),
            signal
          }),
          signal
        )
        throwIfSignalAborted(signal)
        return { repo, worktrees }
      }
    )
    throwIfSignalAborted(signal)

    for (const result of worktreeResults) {
      if (result.status === 'rejected') {
        complete = false
        console.warn(
          '[memory] Worktree enumeration failed during pty-registry hydration:',
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        )
        continue
      }
      const { repo, worktrees } = result.value
      for (const worktree of worktrees) {
        const worktreeId = `${repo.id}::${worktree.path}`
        const key = worktreeIdComparisonKey(worktreeId)
        if (key) {
          const existing = liveGitWorktreeIdsByKey.get(key)
          liveGitWorktreeIdsByKey.set(
            key,
            existing === undefined || existing === worktreeId ? worktreeId : null
          )
        }
      }
    }

    inventory = await collectSessionInfos(provider, signal)
    complete = complete && inventory.complete
    alreadyRegistered = new Set(listRegisteredPtys().map((pty) => pty.ptyId))
  }

  throwIfSignalAborted(signal)
  for (const info of inventory.sessions) {
    throwIfSignalAborted(signal)
    if (alreadyRegistered.has(info.sessionId)) {
      continue
    }
    const { worktreeId } = parsePtySessionId(info.sessionId)
    if (!worktreeId || !isVerifiedLocalWorktree(worktreeId)) {
      continue
    }
    registerPty({
      ptyId: info.sessionId,
      worktreeId,
      sessionId: info.sessionId,
      paneKey: null,
      pid:
        typeof info.pid === 'number' && Number.isFinite(info.pid) && info.pid > 0 ? info.pid : null
    })
  }
  return complete

  function isVerifiedLocalWorktree(worktreeId: string): boolean {
    if (verifiedFolderWorktreeIds.has(worktreeId)) {
      return true
    }
    const key = worktreeIdComparisonKey(worktreeId)
    return key !== null && typeof liveGitWorktreeIdsByKey.get(key) === 'string'
  }
}

function getLocalRepoCatalog(repos: Repo[]): LocalRepoCatalog {
  const byId = new Map<string, Repo>()
  const ownerCountById = new Map<string, number>()
  const ambiguousIds = new Set<string>()
  for (const repo of repos) {
    ownerCountById.set(repo.id, (ownerCountById.get(repo.id) ?? 0) + 1)
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    if (byId.has(repo.id)) {
      ambiguousIds.add(repo.id)
    } else {
      byId.set(repo.id, repo)
    }
  }
  for (const repoId of ambiguousIds) {
    byId.delete(repoId)
  }
  return { byId, ownerCountById }
}

function getVerifiedFolderWorktreeIds(
  store: HydrationStore,
  repoCatalog: LocalRepoCatalog
): Set<string> {
  const verified = new Set<string>()
  const metadata = readAllWorktreeMetaForHost(store, LOCAL_EXECUTION_HOST_ID)
  for (const [worktreeId, meta] of Object.entries(metadata)) {
    const parsed = splitWorktreeId(worktreeId)
    const repo = parsed ? repoCatalog.byId.get(parsed.repoId) : undefined
    const hasLocalAuthority =
      meta.hostId === LOCAL_EXECUTION_HOST_ID ||
      (meta.hostId === undefined && repoCatalog.ownerCountById.get(parsed?.repoId ?? '') === 1)
    if (
      repo &&
      isFolderRepo(repo) &&
      hasLocalAuthority &&
      isFolderWorkspaceIdForRepo(repo, worktreeId)
    ) {
      verified.add(worktreeId)
    }
  }
  return verified
}

async function collectSessionInfos(
  provider: DaemonPtyRouter | DaemonPtyAdapter | DegradedDaemonPtyProvider,
  signal: AbortSignal
): Promise<DaemonInventory> {
  const adapters =
    'getAllAdapters' in provider && typeof provider.getAllAdapters === 'function'
      ? provider.getAllAdapters()
      : [provider]
  const results = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        throwIfSignalAborted(signal)
        const sessions = await waitForPromiseWithSignal<SessionInfo[]>(
          adapter.listSessions(),
          signal
        )
        throwIfSignalAborted(signal)
        return { complete: true, sessions }
      } catch (error) {
        throwIfSignalAborted(signal)
        console.warn(
          '[memory] listSessions failed for one adapter during hydration:',
          error instanceof Error ? error.message : String(error)
        )
        return { complete: false, sessions: [] }
      }
    })
  )
  const sessions: SessionInfo[] = []
  for (const result of results) {
    for (const session of result.sessions) {
      sessions.push(session)
    }
  }
  return {
    complete: results.length > 0 && results.every((result) => result.complete),
    sessions
  }
}
