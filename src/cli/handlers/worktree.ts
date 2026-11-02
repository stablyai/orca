import { parentCwdNextSteps, withWorktreeSelectorRecovery } from '../worktree-selector-recovery'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord,
  RuntimeWorktreeSetResult,
  RuntimeWorktreeCreateResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printHookWarning, printPreservedBranchWarning } from './worktree-removal-warnings'
import { requestWorktreeRemoval } from './worktree-removal-request'
import { formatWorktreeList, formatWorktreePs, formatWorktreeShow, printResult } from '../format'
import {
  annotateOmittedHostScope,
  type WithAnnotatedHostScope
} from '../omitted-host-scope-selectors'
import { RuntimeClientError } from '../runtime-client'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../flags'
import {
  getOptionalWorktreeSelector,
  getRequiredWorktreeSelector,
  resolveWorktreeCreateCwdContext,
  resolveCurrentWorktreeSelector
} from '../selectors'
import type { TuiAgent } from '../../shared/tui-agent'
import { parseCliAgent, readCliAgentLaunch } from '../agent-launch-request'
import { createWorktreeWithAgent } from './worktree-create-agent-launch'
import { printLineageSummary } from './worktree-lineage-summary'
import { projectWorktreePsTerminalVerdict } from '../worktree-ps-terminal-verdict'
import {
  assertWorkspaceTargetFlagsCompatible,
  hasWorkspaceProjectTarget,
  getCreateRepoTarget,
  type CliRepoTarget
} from '../worktree-project-target'
import {
  assertWorktreeParentFlagsCompatible,
  getEnvParentWorkspace,
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

function getOptionalStartupAgent(flags: Map<string, string | boolean>): TuiAgent | undefined {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    const needsAgent = ['prompt', 'model', 'effort', 'surface', 'retry-launch'].find((name) =>
      flags.has(name)
    )
    if (needsAgent) {
      throw new RuntimeClientError('invalid_argument', `--${needsAgent} requires --agent`)
    }
    return undefined
  }
  return parseCliAgent(agent)
}

function getOptionalSetupDecision(
  flags: Map<string, string | boolean>
): 'run' | 'skip' | 'inherit' | undefined {
  const setup = getPresentStringFlag(flags, 'setup')
  if (setup !== undefined && setup !== 'run' && setup !== 'skip' && setup !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--setup must be one of: run, skip, inherit')
  }
  if (flags.get('run-hooks') === true && setup !== undefined && setup !== 'run') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --run-hooks or --setup run, not contradictory setup flags.'
    )
  }
  return setup
}

export const WORKTREE_HANDLERS: Record<string, CommandHandler> = {
  'worktree ps': async ({ flags, client, json }) => {
    const result = await client.call<WithAnnotatedHostScope<RuntimeWorktreePsResult>>(
      'worktree.ps',
      {
        limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
        ...(json && flags.has('agent-wait') ? { includeAgentWait: true } : {})
      }
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
      worktree: await resolveCurrentWorktreeSelector(cwd, client, 'current')
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree create': async (context) => {
    const { flags, client, cwd, json, rawArgs } = context
    const referenceInputs = getCreateReferenceInputs(flags)
    assertWorktreeParentFlagsCompatible(flags)
    assertWorkspaceTargetFlagsCompatible(flags)
    const branchNameOverride = getPresentStringFlag(flags, 'branch')
    const reviewLinks = getReviewTargetLinkFlags(flags)
    const callerTerminalHandle = process.env.ORCA_TERMINAL_HANDLE || undefined
    const explicitParent = await resolveCreateParentSelector(flags, cwd, client)
    const explicitParentWorktree = explicitParent.parentWorktree
    const explicitParentWorkspace = explicitParent.parentWorkspace
    const startupAgent = getOptionalStartupAgent(flags)
    // Read before any request, so a bad prompt, model or effort creates nothing.
    const agentLaunch = startupAgent
      ? readCliAgentLaunch(flags, startupAgent, { createsWorktree: true })
      : undefined
    const setupDecision = getOptionalSetupDecision(flags)
    const noParent = flags.get('no-parent') === true
    const inferParent = !explicitParentWorktree && !explicitParentWorkspace && !noParent
    const envParentWorkspace = inferParent ? getEnvParentWorkspace() : undefined
    let cwdContext: Awaited<ReturnType<typeof resolveWorktreeCreateCwdContext>> = {}
    const needsCwdRepoInference = !flags.has('repo') && !hasWorkspaceProjectTarget(flags)
    if (inferParent || needsCwdRepoInference) {
      try {
        // Cwd preserves parent/repo inference when agent shells lose ORCA_TERMINAL_HANDLE.
        cwdContext = await resolveWorktreeCreateCwdContext(
          cwd,
          client,
          needsCwdRepoInference,
          inferParent
        )
      } catch (error) {
        if (
          needsCwdRepoInference &&
          error instanceof RuntimeClientError &&
          error.code === 'selector_ambiguous'
        ) {
          throw error
        }
        cwdContext = {}
      }
    }
    const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue')
    const activate = flags.get('activate') === true || flags.get('run-hooks') === true
    const name = getRequiredStringFlag(flags, 'name')
    const repoTarget: CliRepoTarget = cwdContext.repoId
      ? { repo: `id:${cwdContext.repoId}` }
      : await getCreateRepoTarget(flags, undefined, client)
    await assertGitLabLinkFlagProjectsMatch(flags, client, repoTarget)
    const linkedItems = referenceInputs
      ? await resolveReferenceInputs(context, referenceInputs)
      : undefined
    if (linkedItems) {
      await assertReferenceWritesSupported(client)
    }
    const create = {
      // Older hosts drop `repoHostId` and keep refusing an id on several hosts, as before.
      ...repoTarget,
      name,
      displayName: name,
      displayNameKind: 'user',
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      branchNameOverride,
      ...reviewLinks,
      ...linearIssueLink,
      ...(linkedItems ? { linkedItems } : {}),
      comment: getOptionalStringFlag(flags, 'comment'),
      runHooks: flags.get('run-hooks') === true,
      activate,
      // CLI activation targets its runtime's desktop, never unrelated paired viewers.
      ...(activate ? { navigation: 'host' as const } : {}),
      ...(setupDecision ? { setupDecision } : {}),
      parentWorktree: explicitParentWorktree,
      ...(explicitParentWorkspace ? { parentWorkspace: explicitParentWorkspace } : {}),
      ...(envParentWorkspace ? { envParentWorkspace } : {}),
      ...(cwdContext.parentWorktree
        ? { cwdParentWorktree: cwdContext.parentWorktree.selector }
        : {}),
      // Older hosts ignore the observation and keep this first-row cwd parent.
      ...(cwdContext.parentAmbiguous ? { cwdParentAmbiguous: cwdContext.parentAmbiguous } : {}),
      noParent,
      callerTerminalHandle,
      // Always request CLI provenance, including hand-typed creates without a terminal handle.
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
    const parentSelector = getOptionalStringFlag(flags, 'parent-worktree')
    if (parentSelector && getWorkspaceKeyParentSelector(parentSelector)?.startsWith('folder:')) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Parent selector "${parentSelector}" is a folder. Folder parents are accepted only by orca worktree create.`
      )
    }
    const isUnread = getOptionalWorktreeUnreadFlag(flags)
    const reviewLinks = getReviewTargetLinkFlags(flags, { nullable: true })
    const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue', {
      allowNull: true
    })
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    await assertGitLabLinkFlagProjectsMatch(flags, client, { worktree })
    const pending = client.call<RuntimeWorktreeSetResult>('worktree.set', {
      worktree,
      displayName: getOptionalStringFlag(flags, 'display-name'),
      ...reviewLinks,
      ...linearIssueLink,
      comment: getOptionalStringFlag(flags, 'comment'),
      workspaceStatus: getOptionalStringFlag(flags, 'workspace-status'),
      isUnread,
      parentWorktree: await withWorktreeSelectorRecovery(
        getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client),
        parentCwdNextSteps(parentSelector),
        parentSelector
      ),
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
    const result = await requestWorktreeRemoval(client, {
      worktree,
      hostId,
      force: flags.get('force') === true,
      deleteBranch: flags.get('delete-branch') === true,
      runHooks: flags.get('run-hooks') === true,
      // Archive failure waivers protect user data separately from --force's PTY-stop waiver.
      allowFailedArchiveHook: flags.get('allow-failed-archive-hook') === true
    })
    printHookWarning(result.result, json)
    printPreservedBranchWarning(result.result, json)
    printResult(result, json, (value) =>
      // Hosts that predate waiting answer on acceptance.
      value.removing
        ? 'removed: false\nOrca is still deleting the checkout in the background.'
        : value.removed === true
          ? 'removed: true'
          : 'Removal is not confirmed.'
    )
  }
}
