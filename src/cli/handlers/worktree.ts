import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord,
  RuntimeWorktreeCreateResult,
  RuntimeWorktreeRemoveResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatWorktreeList, formatWorktreePs, formatWorktreeShow, printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  getOptionalNullableNumberFlag,
  getOptionalNumberFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import {
  getOptionalWorktreeSelector,
  getRequiredWorktreeSelector,
  resolveCurrentWorktreeSelector
} from '../selectors'
import { isTuiAgent } from '../../shared/tui-agent-config'
import {
  assertWorkspaceTargetFlagsCompatible,
  hasWorkspaceProjectTarget,
  resolveProjectCreateRepoSelector
} from '../worktree-project-target'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'

type HookWarningResult = {
  warning?: string
}

type PreservedBranchResult = {
  preservedBranch?: {
    branchName: string
  }
}

function printHookWarning(result: HookWarningResult, json: boolean): void {
  if (!json && result.warning) {
    console.error(`warning: ${result.warning}`)
  }
}

function printPreservedBranchWarning(result: PreservedBranchResult, json: boolean): void {
  if (!json && result.preservedBranch) {
    console.error(
      `warning: local branch "${result.preservedBranch.branchName}" was kept because Git could not safely delete it`
    )
  }
}

function printLineageSummary(result: RuntimeWorktreeCreateResult, json: boolean): void {
  if (json) {
    return
  }
  for (const warning of result.warnings ?? []) {
    console.error(`warning: ${warning.message}`)
  }
  if (result.lineage) {
    const source =
      result.lineage.capture.source === 'terminal-context'
        ? 'terminal'
        : result.lineage.capture.source === 'cwd-context'
          ? 'cwd'
          : result.lineage.capture.source === 'orchestration-context'
            ? 'orchestration'
            : result.lineage.capture.source === 'explicit-cli-flag'
              ? 'explicit flag'
              : 'manual action'
    console.error(
      `parent: ${result.lineage.parentWorktreeId} (${result.lineage.capture.confidence} from ${source})`
    )
  } else {
    console.error('parent: none')
  }
}

function assertParentFlagsCompatible(flags: Map<string, string | boolean>): void {
  if (flags.has('parent-worktree') && flags.get('no-parent') === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --parent-worktree or --no-parent, not both.'
    )
  }
  const parentWorktree = flags.get('parent-worktree')
  if (
    flags.has('parent-worktree') &&
    (typeof parentWorktree !== 'string' || parentWorktree === '')
  ) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --parent-worktree')
  }
}

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowEmpty?: boolean } = {}
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && (options.allowEmpty || value.length > 0)) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

function getOptionalStartupAgent(flags: Map<string, string | boolean>): string | undefined {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    if (flags.has('prompt')) {
      throw new RuntimeClientError('invalid_argument', '--prompt requires --agent')
    }
    return undefined
  }
  if (!isTuiAgent(agent)) {
    throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${agent}"`)
  }
  return agent
}

function getOptionalSetupDecision(
  flags: Map<string, string | boolean>
): 'run' | 'skip' | 'inherit' | undefined {
  const setup = getPresentStringFlag(flags, 'setup')
  if (setup !== undefined && setup !== 'run' && setup !== 'skip' && setup !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--setup must be one of: run, skip, inherit')
  }
  if (flags.get('run-hooks') === true) {
    if (setup !== undefined && setup !== 'run') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose either --run-hooks or --setup run, not contradictory setup flags.'
      )
    }
    return setup
  }
  return setup
}

function getRepoSelectorFromWorktreeSelector(selector: string | undefined): string | undefined {
  if (!selector?.startsWith('id:')) {
    return undefined
  }
  const worktreeId = selector.slice('id:'.length)
  const separatorIndex = worktreeId.indexOf('::')
  if (separatorIndex <= 0) {
    return undefined
  }
  return `id:${worktreeId.slice(0, separatorIndex)}`
}

async function getCreateRepoSelector(
  flags: Map<string, string | boolean>,
  cwdParentWorktree: string | undefined,
  client: Parameters<CommandHandler>[0]['client']
): Promise<string> {
  const projectRepoSelector = await resolveProjectCreateRepoSelector(flags, client)
  if (projectRepoSelector) {
    return projectRepoSelector
  }
  const explicitRepo = getPresentStringFlag(flags, 'repo')
  if (explicitRepo) {
    return explicitRepo
  }
  const inferredRepo = getRepoSelectorFromWorktreeSelector(cwdParentWorktree)
  if (inferredRepo) {
    return inferredRepo
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Missing repo selector. Pass --repo or run from inside an Orca-managed worktree.'
  )
}

export const WORKTREE_HANDLERS: Record<string, CommandHandler> = {
  'worktree ps': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeWorktreePsResult>('worktree.ps', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatWorktreePs)
  },
  'worktree list': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeWorktreeListResult>('worktree.list', {
      repo: getOptionalStringFlag(flags, 'repo'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
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
  'worktree create': async ({ flags, client, cwd, json }) => {
    assertParentFlagsCompatible(flags)
    assertWorkspaceTargetFlagsCompatible(flags)
    const callerTerminalHandle =
      typeof process.env.ORCA_TERMINAL_HANDLE === 'string' &&
      process.env.ORCA_TERMINAL_HANDLE.length > 0
        ? process.env.ORCA_TERMINAL_HANDLE
        : undefined
    const explicitParentWorktree = await getOptionalWorktreeSelector(
      flags,
      'parent-worktree',
      cwd,
      client
    )
    const startupAgent = getOptionalStartupAgent(flags)
    const setupDecision = getOptionalSetupDecision(flags)
    const noParent = flags.get('no-parent') === true
    let cwdParentWorktree: string | undefined
    const needsCwdRepoInference = !flags.has('repo') && !hasWorkspaceProjectTarget(flags)
    if ((!explicitParentWorktree && !noParent) || needsCwdRepoInference) {
      try {
        // Why: agent shells can lose ORCA_TERMINAL_HANDLE while still running
        // inside an Orca worktree. Cwd keeps CLI-created children nestable and
        // lets create infer the repo for the common current-workspace case.
        cwdParentWorktree = await resolveCurrentWorktreeSelector(cwd, client)
      } catch {
        cwdParentWorktree = undefined
      }
    }
    const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue')
    const result = await client.call<RuntimeWorktreeCreateResult>('worktree.create', {
      repo: await getCreateRepoSelector(flags, cwdParentWorktree, client),
      name: getRequiredStringFlag(flags, 'name'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      linkedIssue: getOptionalNumberFlag(flags, 'issue'),
      ...linearIssueLink,
      comment: getOptionalStringFlag(flags, 'comment'),
      runHooks: flags.get('run-hooks') === true,
      activate:
        flags.get('activate') === true || flags.get('run-hooks') === true || Boolean(startupAgent),
      ...(setupDecision ? { setupDecision } : {}),
      parentWorktree: explicitParentWorktree,
      ...(cwdParentWorktree ? { cwdParentWorktree } : {}),
      noParent,
      callerTerminalHandle,
      ...(startupAgent
        ? {
            startupAgent,
            startupPrompt: getPresentStringFlag(flags, 'prompt', { allowEmpty: true }) ?? ''
          }
        : {})
    })
    printHookWarning(result.result, json)
    printLineageSummary(result.result, json)
    printResult(result, json, formatWorktreeShow)
  },
  'worktree set': async ({ flags, client, cwd, json }) => {
    assertParentFlagsCompatible(flags)
    const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue', {
      allowNull: true
    })
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      linkedIssue: getOptionalNullableNumberFlag(flags, 'issue'),
      ...linearIssueLink,
      comment: getOptionalStringFlag(flags, 'comment'),
      workspaceStatus: getOptionalStringFlag(flags, 'workspace-status'),
      parentWorktree: await getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client),
      noParent: flags.get('no-parent') === true
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree rm': async ({ flags, client, cwd, json }) => {
    const result = await client.call<RuntimeWorktreeRemoveResult>('worktree.rm', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      force: flags.get('force') === true,
      runHooks: flags.get('run-hooks') === true
    })
    printHookWarning(result.result, json)
    printPreservedBranchWarning(result.result, json)
    printResult(result, json, (value) => `removed: ${value.removed}`)
  }
}
