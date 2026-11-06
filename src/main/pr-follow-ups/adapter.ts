import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Worktree } from '../../shared/worktree/types'
import type {
  FollowUpHostInputs,
  FollowUpObservation,
  FollowUpObservationSource,
  FollowUpTarget,
  FollowUpWorkspace
} from '../../shared/pr-follow-ups/contracts'
import type { AgentSessionAgentAvailability } from '../../shared/agent-session/agent-session-agent-availability'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { decideAgentLaunchMode } from '../agent-launch/agent-launch-mode'
import { getRepoRoutingConnectionId, getRepoExecutionHostId } from '../../shared/execution-host'
import { isGitHubBackedRepo } from '../../shared/project-host-setup-projection'
import { resolveSourceControlActionRecipe } from '../../shared/source-control/ai/source-control-ai-operation-policy'
import {
  resolveSourceControlActionPreferredSurface,
  resolveSourceControlActionRequestedSurface,
  sourceControlActionAgentArgs,
  sourceControlActionLaunchOptions
} from '../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  prFollowUpCandidate,
  registerPRWatch,
  subscribePRObservations,
  pullRequestActionsFor,
  ownerChatFor
} from '../github/pr-watch/pr-watch-seams'
import { parsePRKey } from '../github/pr-watch/pr-watch-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { prepareFollowUpLaunch } from './launch'
import { followUpSessionLive, followUpSessionWorking } from './adapter-activity'

export function installPrFollowUpAdapter(
  runtime: OrcaRuntimeService,
  store: RuntimeStore,
  catalog: { worktrees(): readonly Worktree[]; worktree(id: string): Worktree | undefined }
): () => Promise<void> {
  const settings = () => store.getSettings() as GlobalSettings
  let availability: readonly AgentSessionAgentAvailability[] = []
  let workspaces: readonly FollowUpWorkspace[] = []
  let targets: readonly FollowUpTarget[] = []
  const listeners = new Set<Parameters<FollowUpHostInputs['subscribeInventory']>[0]>()
  const repoFor = (worktree: Worktree) =>
    store
      .getRepos()
      .find(
        (repo) =>
          repo.id === worktree.repoId &&
          getRepoExecutionHostId(repo) === (worktree.hostId ?? 'local')
      )
  const workspace = (row: Worktree): FollowUpWorkspace | undefined => {
    const repo = repoFor(row)
    if (!row.instanceId || !repo || repo.kind === 'folder' || !isGitHubBackedRepo(repo)) {
      return
    }
    return {
      worktreeId: row.id,
      instanceId: row.instanceId,
      repoId: repo.id,
      connectionId: getRepoRoutingConnectionId(repo) ?? null,
      branch: row.branch.replace(/^refs\/heads\//u, ''),
      prNumber: row.linkedPR,
      archived: row.isArchived,
      settings: repo.prFollowUps
    }
  }
  const target = (row: Worktree, observation: FollowUpObservation): FollowUpTarget | undefined => {
    // The reader resolves a registration before publishing its first observation.
    const candidate = prFollowUpCandidate(observation.prKey)
    const item = workspace(row)
    const number = parsePRKey(observation.prKey)?.number
    if (
      !candidate ||
      !item ||
      candidate.repoId !== item.repoId ||
      (candidate.connectionId ?? null) !== item.connectionId ||
      candidate.branch !== item.branch ||
      (item.prNumber !== null && item.prNumber !== number)
    ) {
      return
    }
    const host = getStructuredAgentSessionHost()
    const chat = host
      ?.loadedSessionIds()
      .map((id) => host.readStatusSummary(id))
      .find(
        (s) => s?.workspaceId === row.id && (s.status === 'working' || s.status === 'attention')
      )
    const hook = runtime
      .getAgentStatusSnapshotFn?.()
      .find(
        (s) =>
          s.worktreeId === row.id &&
          ['working', 'needs-you'].includes(runtime.agentTransitions.phaseOf(s.paneKey))
      )
    return {
      worktreeId: item.worktreeId,
      instanceId: item.instanceId,
      prKey: observation.prKey,
      branch: item.branch,
      lastActiveAt: row.lastActivityAt,
      archived: item.archived,
      settings: item.settings,
      workingAgent:
        chat?.agent ??
        hook?.agentType ??
        (row.smartTier === 'working' || row.smartTier === 'needs-you' ? 'Agent' : null)
    }
  }
  const reuse = <T>(before: readonly T[], after: T[]): readonly T[] => {
    const stable = after.map((item, i) =>
      JSON.stringify(before[i]) === JSON.stringify(item) ? before[i]! : item
    )
    return stable.length === before.length && stable.every((item, i) => item === before[i])
      ? before
      : stable
  }
  const refresh = (): void => {
    const rows = catalog.worktrees()
    workspaces = reuse(
      workspaces,
      rows.flatMap((row) => workspace(row) ?? [])
    )
    targets = reuse(
      targets,
      rows.flatMap((row) => {
        const previous = runtime.prFollowUps?.target(row.id)
        const observation = previous && runtime.prFollowUps?.observation(previous.prKey)
        return observation ? (target(row, observation) ?? []) : []
      })
    )
  }
  const changed = (): void => {
    refresh()
    for (const listener of listeners) {
      listener({})
    }
  }
  const source: FollowUpObservationSource = {
    registerPRWatch,
    pullRequestActionsFor,
    ownerChatFor,
    subscribePRObservations: (onObservation) =>
      subscribePRObservations((observation) => {
        const matching = catalog.worktrees().flatMap((row) => target(row, observation) ?? [])
        if (!matching.length) {
          return
        }
        runtime.prFollowUps?.targetsChanged(matching, [])
        onObservation(observation)
        changed()
      })
  }
  const recipeFor = (item: FollowUpTarget) => {
    const repo = repoFor(catalog.worktree(item.worktreeId)!)
    if (!repo) {
      throw new Error('Repository unavailable')
    }
    const recipe = resolveSourceControlActionRecipe({
      settings: settings(),
      repo,
      actionId: 'fixChecks'
    })
    const global = settings()
    const agent = recipe.agentId ?? global.defaultTuiAgent
    if (!isTuiAgent(agent)) {
      throw new Error('Choose an agent for Fix failing checks in Source Control AI settings')
    }
    const preferred = resolveSourceControlActionPreferredSurface(recipe, agent)
    const mode = decideAgentLaunchMode({
      placement: { agent, ...(repo.connectionId ? { on: repo.connectionId } : {}) },
      settings:
        preferred === 'chat'
          ? { ...global, nativeChatProviders: { ...global.nativeChatProviders, [agent]: true } }
          : global,
      surface: resolveSourceControlActionRequestedSurface(recipe, agent)
    })
    return {
      repo,
      recipe,
      agent,
      surface: mode.mode === 'structured' ? ('chat' as const) : ('terminal' as const)
    }
  }
  const inputs: FollowUpHostInputs = {
    workspaces: () => workspaces,
    targets: () => targets,
    target: (id) => {
      const row = catalog.worktree(id)
      const previous = runtime.prFollowUps?.target(id)
      const observation = previous && runtime.prFollowUps?.observation(previous.prKey)
      return row && observation ? target(row, observation) : undefined
    },
    // Loaded profile metadata is authoritative, even when a checkout cannot be reached.
    inventoryComplete: () => true,
    liveInstanceIds: () =>
      new Set(Object.values(store.getAllWorktreeMeta()).flatMap((row) => row.instanceId ?? [])),
    subscribeInventory: (listener) => {
      listeners.add(listener)
      const releaseStore = store.onStateWritten?.(() => changed())
      const releaseAvailability = runtime.subscribeStructuredAgentAvailability((agents) => {
        if (JSON.stringify(availability) === JSON.stringify(agents)) {
          return
        }
        availability = agents
        void runtime.prFollowUps
          ?.reconcile(targets.map((item) => item.prKey))
          .catch((error: unknown) =>
            console.error('[pr-follow-ups] availability reconciliation failed', error)
          )
      })
      const releaseClient = runtime.onClientEvent(
        (event) => {
          if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
            changed()
          }
        },
        { consumesTerminalSideEffects: false }
      )
      return () => {
        listeners.delete(listener)
        releaseStore?.()
        releaseAvailability()
        releaseClient()
      }
    },
    recipe: (item) => {
      const { agent, surface } = recipeFor(item)
      return { agent, surface }
    },
    launchInputs: (item) => {
      const { agent, recipe, repo, surface } = recipeFor(item)
      const global = settings()
      return {
        agent,
        key: JSON.stringify({
          agent,
          recipe,
          surface,
          availability: availability.find((row) => row.agent === agent),
          args: sourceControlActionAgentArgs(recipe, agent, global),
          options: sourceControlActionLaunchOptions(recipe, agent),
          defaults: global.agentLaunchChoices?.[agent],
          defaultArgs: global.agentDefaultArgs?.[agent],
          chatOptions: global.nativeChatSessionOptions,
          chatPermission: global.nativeChatPermissionMode,
          command: global.agentCmdOverrides?.[agent],
          env: global.agentDefaultEnv?.[agent],
          native: global.nativeChatProviders?.[agent],
          connectionId: repo.connectionId
        })
      }
    },
    prepare: async (observation, names, item) => {
      const { repo } = recipeFor(item)
      const pr = parsePRKey(observation.prKey)
      if (!pr) {
        throw new Error('Pull request unavailable')
      }
      const prRepo = { host: pr.host, owner: pr.owner, repo: pr.repo }
      const checks = await runtime.getRepoPRChecks(repo.id, pr.number, observation.headSha, prRepo)
      return prepareFollowUpLaunch({
        runtime,
        observation,
        names,
        target: item,
        settings: settings(),
        repo,
        pr: {
          number: pr.number,
          title: '',
          url: `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}`
        },
        checks,
        loadDetails: (check) =>
          runtime.getRepoPRCheckDetails(repo.id, { ...check, checkName: check.name, prRepo })
      })
    },
    live: (action) => followUpSessionLive(runtime, action),
    working: (action) => followUpSessionWorking(runtime, action)
  }
  refresh()
  return runtime.installPrFollowUpSource(source, inputs)
}
