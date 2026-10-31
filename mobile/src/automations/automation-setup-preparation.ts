import { parseExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { findAutomationRepo } from '../../../src/shared/automation-repo-target'
import { getAutomationSetupDefaultDecision } from '../../../src/shared/automation-setup-decision'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import {
  newWorkspaceSetupHooksRead,
  newWorkspaceUiStateRead
} from '../components/new-workspace-operations'
import type { SetupTrustPrompt } from '../components/SetupHookTrustDrawer'
import { newTabRepoListRead } from '../session/mobile-session-read-operations'
import {
  isSetupHookTrusted,
  normalizeSetupHookTrust,
  readRepoHooksSetupCommand,
  wasSetupHookPreviouslyApproved
} from '../tasks/setup-hook-trust'
import type { RpcClient } from '../transport/rpc-client'
import type { AutomationDraft } from './automation-draft'
import { AutomationDraftValidationError } from './automation-error'
import {
  automationRepoSchema,
  automationSetupKey,
  type AutomationTargets
} from './automation-target-inventory'

export async function prepareAutomationSetup(args: {
  client: RpcClient
  executionHost?: ExecutionHostId
  draft: AutomationDraft
  original?: AutomationDraft
  targets: AutomationTargets
  current: () => boolean
  confirm: (
    prompt: SetupTrustPrompt,
    trust: PersistedTrustedOrcaHooks
  ) => Promise<'run' | 'skip' | null>
}): Promise<AutomationDraft | null> {
  const { client, draft, original, targets, current } = args
  if (
    original &&
    !draft.targetEdited &&
    !draft.setupDecisionEdited &&
    draft.setupId === original.setupId &&
    draft.workspaceMode === original.workspaceMode &&
    draft.workspaceId === original.workspaceId &&
    draft.setupDecision === original.setupDecision
  ) {
    return draft
  }
  if (draft.workspaceMode !== 'new_per_run') {
    return { ...draft, setupDecision: 'inherit' }
  }
  if (draft.setupDecision === 'skip') {
    return draft
  }
  const setup = targets.setups.find((entry) => automationSetupKey(entry) === draft.setupId)
  if (!setup) {
    throw new AutomationDraftValidationError('project')
  }
  let rawRepos: ReturnType<typeof newTabRepoListRead.interpret>
  try {
    rawRepos = newTabRepoListRead.interpret(await newTabRepoListRead.request(client))
  } catch {
    return current() ? { ...draft, setupDecision: 'skip' } : null
  }
  if (!current()) {
    return null
  }
  // repo.hooks accepts only an id selector; prove it cannot inspect a same-id twin.
  const candidates = rawRepos.filter((repo) => repo.id === setup.repoId)
  const parsed = automationRepoSchema.safeParse(candidates.length === 1 ? candidates[0] : null)
  const repos = parsed.success ? [parsed.data] : []
  if (!findAutomationRepo(repos, setup.repoId, setup)) {
    throw new AutomationDraftValidationError('project')
  }
  let details: ReturnType<typeof newWorkspaceSetupHooksRead.interpret>
  try {
    details = newWorkspaceSetupHooksRead.interpret(
      await newWorkspaceSetupHooksRead.request(client, { repo: `id:${setup.repoId}` })
    )
  } catch {
    return current() ? { ...draft, setupDecision: 'skip' } : null
  }
  if (!current()) {
    return null
  }
  if (!details.accepted) {
    return { ...draft, setupDecision: 'skip' }
  }
  if (!readRepoHooksSetupCommand(details.value)) {
    return { ...draft, setupDecision: 'inherit' }
  }
  const decision =
    draft.setupDecision === 'inherit'
      ? getAutomationSetupDefaultDecision({
          setupRunPolicy: details.value.setupRunPolicy ?? 'run-by-default'
        })
      : draft.setupDecision
  const setupTrust = normalizeSetupHookTrust(details.value.setupTrust)
  if (decision !== 'run' || !setupTrust) {
    return { ...draft, setupDecision: decision ?? 'inherit' }
  }
  let trust: PersistedTrustedOrcaHooks = {}
  if (parseExecutionHostId(args.executionHost)?.kind !== 'runtime') {
    try {
      const reply = newWorkspaceUiStateRead.interpret(await newWorkspaceUiStateRead.request(client))
      if (reply.accepted) {
        trust = reply.value?.trustedOrcaHooks ?? {}
      }
    } catch {
      // An unreadable approval record grants no trust.
    }
    if (!current()) {
      return null
    }
    if (isSetupHookTrusted(trust, repos, setup.repoId, setupTrust.contentHash)) {
      return { ...draft, setupDecision: 'run' }
    }
  }
  const approved = await args.confirm(
    {
      repoId: setup.repoId,
      repoName: setup.displayName,
      ...setupTrust,
      previouslyApproved: wasSetupHookPreviouslyApproved(trust, setup.repoId)
    },
    trust
  )
  return approved && current() ? { ...draft, setupDecision: approved } : null
}
