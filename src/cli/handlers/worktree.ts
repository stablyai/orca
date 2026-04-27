import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatWorktreeList, formatWorktreePs, formatWorktreeShow, printResult } from '../format'
import {
  getOptionalNullableNumberFlag,
  getOptionalNumberFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { getRequiredWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'

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
  'worktree create': async ({ flags, client, json }) => {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.create', {
      repo: getRequiredStringFlag(flags, 'repo'),
      name: getRequiredStringFlag(flags, 'name'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      linkedIssue: getOptionalNumberFlag(flags, 'issue'),
      comment: getOptionalStringFlag(flags, 'comment')
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree set': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      linkedIssue: getOptionalNullableNumberFlag(flags, 'issue'),
      comment: getOptionalStringFlag(flags, 'comment')
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree rm': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ removed: boolean }>('worktree.rm', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      force: flags.get('force') === true
    })
    printResult(result, json, (value) => `removed: ${value.removed}`)
  }
}
