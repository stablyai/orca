import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord,
  RuntimeWorktreeCreateResult
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

type HookWarningResult = {
  warning?: string
}

function printHookWarning(result: HookWarningResult, json: boolean): void {
  if (!json && result.warning) {
    console.error(`warning: ${result.warning}`)
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
    const noParent = flags.get('no-parent') === true
    let cwdParentWorktree: string | undefined
    if (!explicitParentWorktree && !noParent) {
      try {
        // Why: agent shells can lose ORCA_TERMINAL_HANDLE while still running
        // inside an Orca worktree. Cwd keeps CLI-created children nestable.
        cwdParentWorktree = await resolveCurrentWorktreeSelector(cwd, client)
      } catch {
        cwdParentWorktree = undefined
      }
    }
    const result = await client.call<RuntimeWorktreeCreateResult>('worktree.create', {
      repo: getRequiredStringFlag(flags, 'repo'),
      name: getRequiredStringFlag(flags, 'name'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      linkedIssue: getOptionalNumberFlag(flags, 'issue'),
      comment: getOptionalStringFlag(flags, 'comment'),
      runHooks: flags.get('run-hooks') === true,
      activate: flags.get('activate') === true || flags.get('run-hooks') === true,
      parentWorktree: explicitParentWorktree,
      ...(cwdParentWorktree ? { cwdParentWorktree } : {}),
      noParent,
      callerTerminalHandle
    })
    printHookWarning(result.result, json)
    printLineageSummary(result.result, json)
    printResult(result, json, formatWorktreeShow)
  },
  'worktree set': async ({ flags, client, cwd, json }) => {
    assertParentFlagsCompatible(flags)
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      linkedIssue: getOptionalNullableNumberFlag(flags, 'issue'),
      comment: getOptionalStringFlag(flags, 'comment'),
      parentWorktree: await getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client),
      noParent: flags.get('no-parent') === true
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree rm': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ removed: boolean; warning?: string }>('worktree.rm', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      force: flags.get('force') === true,
      runHooks: flags.get('run-hooks') === true
    })
    printHookWarning(result.result, json)
    printResult(result, json, (value) => `removed: ${value.removed}`)
  }
}
