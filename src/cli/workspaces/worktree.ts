import { withFolderSetupSupportWarning } from './folder-setup-support-warning'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord,
  RuntimeWorktreeCreateResult
} from '../../shared/runtime-worktree-contracts'
import type { CommandHandler } from '../dispatch/dispatch'
import { printHookWarning, printPreservedBranchWarning } from './worktree-removal-warnings'
import { requestWorktreeRemoval } from './worktree-removal-request'
import { removeIfFolderWorkspace } from './folder-workspace-mutations'
import { formatWorktreeList, formatWorktreePs, formatWorktreeShow } from './workspace-format'
import { printResult } from '../output/command-result-output'
import {
  annotateOmittedHostScope,
  type WithAnnotatedHostScope
} from '../hosts/omitted-host-scope-selectors'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import {
  getRequiredWorktreeSelector,
  resolveWorktreeCreateCwdContext,
  resolveCurrentWorktreeSelector
} from '../workspace-selection/workspace-selector'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { parseCliAgent, readCliAgentLaunch } from '../agents/agent-launch-request'
import { createWorktreeWithAgent } from './worktree-create-agent-launch'
import { printLineageSummary } from './worktree-lineage-summary'
import { resolveCreateParentFields } from './worktree-parent-fields'
import { callNamingParentEnvironment } from './worktree-parent-environment'
import { annotatePsRows, annotateShown } from './worktree-address-annotation'
import { refuseCurrentForRemoval } from './worktree-removal-current-refusal'
import { projectWorktreePsTerminalVerdict } from './worktree-ps-terminal-verdict'
import {
  assertWorkspaceTargetFlagsCompatible,
  hasWorkspaceProjectTarget,
  getCreateRepoTarget,
  type CliRepoTarget
} from './worktree-project-target'
import {
  assertWorktreeParentFlagsCompatible,
  getEnvParentWorkspace,
  resolveCreateParentSelector
} from './worktree-create-parent-selector'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'
import { getReviewTargetLinkFlags } from './worktree-review-link-flags'
import {
  getOptionalSetupDecision,
  withSetupDecisionRecovery
} from './worktree-setup-decision-recovery'
import { assertGitLabLinkFlagProjectsMatch } from './worktree-gitlab-link-context'
import {
  assertReferenceWritesSupported,
  getCreateReferenceInputs,
  resolveReferenceInputs
} from '../references/reference-input'
import { worktreeSetHandler } from './worktree-set'

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
    const annotate = await annotatePsRows(client, result.result.worktrees)
    const worktrees = annotate(result.result.worktrees.map(projectWorktreePsTerminalVerdict))
    printResult({ ...result, result: { ...result.result, worktrees } }, json, () =>
      formatWorktreePs({ ...result.result, worktrees: annotate(result.result.worktrees) })
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
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      matchFolderWorkspaces: true
    })
    printResult(await annotateShown(client, result), json, formatWorktreeShow)
  },
  'worktree current': async ({ client, cwd, json }) => {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: await resolveCurrentWorktreeSelector(cwd, client, 'current')
    })
    printResult(await annotateShown(client, result), json, formatWorktreeShow)
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
      : await getCreateRepoTarget(flags, undefined, client, explicitParentWorkspace)
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
      ...(await resolveCreateParentFields(client, {
        explicitParent,
        inferredParent: envParentWorkspace,
        cwd,
        flags,
        cwdContext,
        callerTerminalHandle,
        noParent
      })),
      // Always request CLI provenance, including hand-typed creates without a terminal handle.
      cliProvenanceRequest: callerTerminalHandle ? { callerTerminalHandle } : {}
    }
    if (agentLaunch) {
      await createWorktreeWithAgent({ client, flags, create, launch: agentLaunch, json, rawArgs })
      return
    }
    const result = await withSetupDecisionRecovery(
      callNamingParentEnvironment<RuntimeWorktreeCreateResult>(client, 'worktree.create', create)
    )
    const created = {
      ...result,
      result: await withFolderSetupSupportWarning(client, result.result, create)
    }
    printHookWarning(created.result, json)
    printLineageSummary(created.result, json)
    printResult(created, json, formatWorktreeShow)
  },
  'worktree set': worktreeSetHandler,
  'worktree rm': async ({ flags, client, cwd, json }) => {
    await refuseCurrentForRemoval(flags, cwd, client)
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    if (await removeIfFolderWorkspace(client, flags, worktree, json)) {
      return
    }
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
