import { parentCwdNextSteps, withWorktreeSelectorRecovery } from '../worktree-selector-recovery'
import { getOptionalStartupAgent, getOptionalSetupDecision } from './worktree-create-options'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord,
  RuntimeWorktreeSetResult,
  RuntimeWorktreeCreateResult,
  RuntimeWorktreeRemoveResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printHookWarning, printPreservedBranchWarning } from './worktree-removal-warnings'
import { formatWorktreeList, formatWorktreePs, formatWorktreeShow, printResult } from '../format'
import {
  annotateOmittedHostScope,
  type WithAnnotatedHostScope
} from '../omitted-host-scope-selectors'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import {
  getRequiredWorktreeSelector,
  resolveCurrentWorktreeSelection,
  resolveCurrentWorktreeSelector
} from '../selectors'
import type { HostScopedWorktreeSelection } from '../caller-host-worktree-selection'
import { readCliAgentLaunch } from '../agent-launch-request'
import { createWorktreeWithAgent } from './worktree-create-agent-launch'
import { printLineageSummary } from './worktree-lineage-summary'
import { projectWorktreePsTerminalVerdict } from '../worktree-ps-terminal-verdict'
import {
  assertWorkspaceTargetFlagsCompatible,
  hasWorkspaceProjectTarget,
  getCreateRepoTarget
} from '../worktree-project-target'
import {
  assertWorktreeParentFlagsCompatible,
  getEnvParentWorkspace,
  localParentClient,
  resolveCallerParentRef,
  getWorkspaceKeyParentSelector,
  resolveCreateParentSelector
} from './worktree-create-parent-selector'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'
import { getOptionalWorktreeUnreadFlag } from './worktree-unread-flag'
import { getReviewTargetLinkFlags } from './worktree-review-link-flags'
import { withSetupDecisionRecovery } from './worktree-setup-decision-recovery'
import { assertGitLabLinkFlagProjectsMatch } from './worktree-gitlab-link-context'
import {
  assertReferenceWritesSupported,
  getCreateReferenceInputs,
  resolveReferenceInputs
} from '../reference-input'

export const WORKTREE_HANDLERS: Record<string, CommandHandler> = {
  'worktree ps': async ({ flags, client, json }) => {
    const result = await client.call<WithAnnotatedHostScope<RuntimeWorktreePsResult>>(
      'worktree.ps',
      { limit: getOptionalPositiveIntegerFlag(flags, 'limit') }
    )
    await annotateOmittedHostScope(result.result)
    const worktrees = result.result.worktrees.map(projectWorktreePsTerminalVerdict)
    printResult({ ...result, result: { ...result.result, worktrees } }, json, () =>
      formatWorktreePs(result.result)
    )
  },
  'worktree list': async ({ flags, client, json }) => {
    const result = await client.call<WithAnnotatedHostScope<RuntimeWorktreeListResult>>(
      'worktree.list',
      {
        repo: getOptionalStringFlag(flags, 'repo'),
        limit: getOptionalPositiveIntegerFlag(flags, 'limit')
      }
    )
    await annotateOmittedHostScope(result.result)
    printResult(result, json, formatWorktreeList)
  },
  'worktree show': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree current': async ({ client, cwd, json }) => {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: await resolveCurrentWorktreeSelector(cwd, client)
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree create': async (context) => {
    const { flags, client, cwd, json, rawArgs } = context
    const referenceInputs = getCreateReferenceInputs(flags)
    assertWorktreeParentFlagsCompatible(flags)
    assertWorkspaceTargetFlagsCompatible(flags)
    const reviewLinks = getReviewTargetLinkFlags(flags)
    const callerTerminalHandle =
      typeof process.env.ORCA_TERMINAL_HANDLE === 'string' &&
      process.env.ORCA_TERMINAL_HANDLE.length > 0
        ? process.env.ORCA_TERMINAL_HANDLE
        : undefined
    const explicitParent = await resolveCreateParentSelector(flags, cwd, client).catch(
      (error: unknown) => {
        if (
          error instanceof RuntimeClientError &&
          !(error instanceof RuntimeRpcFailureError) &&
          error.code === 'selector_not_found' &&
          getEnvParentWorkspace()?.startsWith('folder:')
        ) {
          throw new RuntimeClientError(
            error.code,
            client.isRemote
              ? "Couldn't find the parent. Name the parent explicitly on the selected computer."
              : "Couldn't find the parent. If you're in a folder workspace, name the parent folder workspace explicitly.",
            error.data
          )
        }
        throw error
      }
    )
    const explicitParentWorktree = explicitParent.parentWorktree
    const explicitParentWorkspace = explicitParent.parentWorkspace
    const startupAgent = getOptionalStartupAgent(flags)
    const agentLaunch = startupAgent
      ? readCliAgentLaunch(flags, startupAgent, { createsWorktree: true })
      : undefined
    const setupDecision = getOptionalSetupDecision(flags)
    const noParent = flags.get('no-parent') === true
    const envParentWorkspace =
      !noParent && !explicitParentWorkspace && !explicitParentWorktree
        ? getEnvParentWorkspace()
        : undefined
    let cwdParentWorktree: HostScopedWorktreeSelection | undefined
    const needsCwdRepoInference = !flags.has('repo') && !hasWorkspaceProjectTarget(flags)
    if (
      (!explicitParentWorktree && !explicitParentWorkspace && !noParent) ||
      needsCwdRepoInference
    ) {
      try {
        // Cwd preserves parent context when an agent shell loses its injected handle.
        cwdParentWorktree = await resolveCurrentWorktreeSelection(cwd, localParentClient(client))
      } catch {
        cwdParentWorktree = undefined
      }
    }
    const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue')
    const activate = flags.get('activate') === true || flags.get('run-hooks') === true
    const name = getRequiredStringFlag(flags, 'name')
    const repoTarget = await getCreateRepoTarget(flags, cwdParentWorktree, client)
    await assertGitLabLinkFlagProjectsMatch(flags, client, repoTarget)
    const linkedItems = referenceInputs
      ? await resolveReferenceInputs(context, referenceInputs)
      : undefined
    if (linkedItems) {
      await assertReferenceWritesSupported(client)
    }
    const explicitParentSelector = explicitParentWorktree ?? explicitParentWorkspace
    const parentWorktreeRef =
      !noParent && explicitParent.origin !== 'target'
        ? await resolveCallerParentRef(
            client,
            explicitParentSelector ?? envParentWorkspace ?? cwdParentWorktree?.selector,
            Boolean(explicitParentSelector)
          )
        : undefined
    const create = {
      ...repoTarget,
      name,
      displayName: name,
      displayNameKind: 'user',
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      ...reviewLinks,
      ...linearIssueLink,
      ...(linkedItems ? { linkedItems } : {}),
      comment: getOptionalStringFlag(flags, 'comment'),
      runHooks: flags.get('run-hooks') === true,
      activate,
      // CLI activation targets its runtime's desktop, never unrelated paired viewers.
      ...(activate ? { navigation: 'host' as const } : {}),
      ...(setupDecision ? { setupDecision } : {}),
      parentWorktreeRef,
      parentWorktree: parentWorktreeRef ? undefined : explicitParentWorktree,
      ...(!parentWorktreeRef && explicitParentWorkspace
        ? { parentWorkspace: explicitParentWorkspace }
        : {}),
      ...(!parentWorktreeRef && !client.isRemote && envParentWorkspace
        ? { envParentWorkspace }
        : {}),
      ...(!parentWorktreeRef && !client.isRemote && cwdParentWorktree
        ? { cwdParentWorktree: cwdParentWorktree.selector }
        : {}),
      noParent,
      callerTerminalHandle: client.isRemote ? undefined : callerTerminalHandle,
      cliProvenanceRequest: callerTerminalHandle ? { callerTerminalHandle } : {}
    }
    if (agentLaunch) {
      await createWorktreeWithAgent({ client, flags, create, launch: agentLaunch, json, rawArgs })
      return
    }
    const result = await withSetupDecisionRecovery(
      client.call<RuntimeWorktreeCreateResult>('worktree.create', create)
    )
    printHookWarning(result.result, json)
    printLineageSummary(result.result, json)
    printResult(result, json, formatWorktreeShow)
  },
  'worktree set': async ({ flags, client, cwd, json }) => {
    assertWorktreeParentFlagsCompatible(
      flags,
      'Choose either --parent-worktree or --no-parent, not both.'
    )
    const rawParentSelector = getOptionalStringFlag(flags, 'parent-worktree')
    if (
      rawParentSelector &&
      getWorkspaceKeyParentSelector(rawParentSelector)?.startsWith('folder:')
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Parent selector "${rawParentSelector}" is a folder. Folder parents are accepted only by orca worktree create.`
      )
    }
    const isUnread = getOptionalWorktreeUnreadFlag(flags)
    const reviewLinks = getReviewTargetLinkFlags(flags, { nullable: true })
    const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue', {
      allowNull: true
    })
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    await assertGitLabLinkFlagProjectsMatch(flags, client, { worktree })
    const parentSelection = await withWorktreeSelectorRecovery(
      resolveCreateParentSelector(flags, cwd, client),
      parentCwdNextSteps(rawParentSelector),
      rawParentSelector
    )
    const parentSelector = parentSelection.parentWorktree ?? parentSelection.parentWorkspace
    const parentWorktreeRef =
      parentSelection.origin === 'caller'
        ? await resolveCallerParentRef(client, parentSelector, true)
        : undefined
    const pending = client.call<RuntimeWorktreeSetResult>('worktree.set', {
      worktree,
      displayName: getOptionalStringFlag(flags, 'display-name'),
      ...reviewLinks,
      ...linearIssueLink,
      comment: getOptionalStringFlag(flags, 'comment'),
      workspaceStatus: getOptionalStringFlag(flags, 'workspace-status'),
      isUnread,
      parentWorktreeRef,
      parentWorktree: parentWorktreeRef ? undefined : parentSelector,
      noParent: flags.get('no-parent') === true
    })
    const result = await withWorktreeSelectorRecovery(
      pending,
      parentSelector
        ? [
            `Orca could not find the worktree selector "${worktree}" or the parent selector "${parentSelector}". The server did not identify which selector failed.`,
            'Check both selectors with orca worktree show --worktree <selector> --json.'
          ]
        : []
    )
    if (!json) {
      for (const warning of result.result.warnings ?? []) {
        console.error(`warning: ${warning.message}`)
      }
    }
    printResult(result, json, formatWorktreeShow)
  },
  'worktree rm': async ({ flags, client, cwd, json }) => {
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    const resolved = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree
    })
    const hostId = resolved.result.worktree.hostId
    if (!hostId) {
      throw new RuntimeClientError(
        'worktree_host_unresolved',
        'Orca cannot tell which host owns this workspace. Refresh projects and try again.'
      )
    }
    if (flags.get('allow-failed-archive-hook') === true && flags.get('run-hooks') !== true) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--allow-failed-archive-hook waives a FAILED archive hook, but without --run-hooks no hook runs at all. Pass --run-hooks too, or drop the waiver.'
      )
    }
    const result = await client.call<RuntimeWorktreeRemoveResult>('worktree.rm', {
      worktree,
      hostId,
      force: flags.get('force') === true,
      // --force also waives PTY-stop proof.
      allowUnverifiedPtyStop: flags.get('force') === true,
      runHooks: flags.get('run-hooks') === true,
      // Archive failure waivers protect user data separately from --force's PTY-stop waiver.
      allowFailedArchiveHook: flags.get('allow-failed-archive-hook') === true
    })
    printHookWarning(result.result, json)
    printPreservedBranchWarning(result.result, json)
    printResult(result, json, (value) =>
      value.removing
        ? `removed: ${value.removed}\nOrca is still deleting the checkout in the background.`
        : `removed: ${value.removed}`
    )
  }
}
