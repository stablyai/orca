import type {
  RuntimeQuickCommandList,
  RuntimeQuickCommandMutation,
  RuntimeQuickCommandRemoval,
  RuntimeQuickCommandShow
} from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { getOptionalWorktreeSelector } from '../selectors'
import {
  formatQuickCommandList,
  formatQuickCommandRemoval,
  formatQuickCommandShow
} from '../quick-command-format'

type Flags = Map<string, string | boolean>

// Why: `active`/`current` and bare relative paths are cwd shortcuts the runtime
// cannot resolve, so they must be normalized client-side like every other
// command that takes --worktree.
async function quickCommandTarget({
  flags,
  cwd,
  client
}: HandlerContext): Promise<{ repo?: string; worktree?: string }> {
  return {
    repo: getOptionalStringFlag(flags, 'repo'),
    worktree: await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
  }
}

// Why: --enter/--no-enter must stay tri-state so `set` leaves the saved value
// alone when neither flag is passed.
function appendEnterFlag(flags: Flags): boolean | undefined {
  if (flags.has('no-enter')) {
    return false
  }
  return flags.has('enter') ? true : undefined
}

function quickCommandBody(flags: Flags): Record<string, unknown> {
  const agent = getOptionalStringFlag(flags, 'agent')
  return {
    agent,
    prompt: getOptionalStringFlag(flags, 'prompt'),
    command: getOptionalStringFlag(flags, 'command'),
    appendEnter: appendEnterFlag(flags),
    action: agent ? 'agent-prompt' : flags.has('command') ? 'terminal-command' : undefined
  }
}

export const QUICK_COMMAND_HANDLERS: Record<string, CommandHandler> = {
  'quick-command list': async (ctx) => {
    const { flags, client, json } = ctx
    const result = await client.call<RuntimeQuickCommandList>('quickCommand.list', {
      ...(await quickCommandTarget(ctx)),
      scope: getOptionalStringFlag(flags, 'scope')
    })
    printResult(result, json, formatQuickCommandList)
  },
  'quick-command show': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeQuickCommandShow>('quickCommand.show', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatQuickCommandShow)
  },
  'quick-command create': async (ctx) => {
    const { flags, client, json } = ctx
    const result = await client.call<RuntimeQuickCommandMutation>('quickCommand.create', {
      ...(await quickCommandTarget(ctx)),
      ...quickCommandBody(flags),
      id: getOptionalStringFlag(flags, 'id'),
      label: getRequiredStringFlag(flags, 'label')
    })
    printResult(result, json, formatQuickCommandShow)
  },
  'quick-command set': async (ctx) => {
    const { flags, client, json } = ctx
    const result = await client.call<RuntimeQuickCommandMutation>('quickCommand.update', {
      ...(await quickCommandTarget(ctx)),
      ...quickCommandBody(flags),
      id: getRequiredStringFlag(flags, 'id'),
      label: getOptionalStringFlag(flags, 'label'),
      global: flags.has('global') ? true : undefined
    })
    printResult(result, json, formatQuickCommandShow)
  },
  'quick-command rm': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeQuickCommandRemoval>('quickCommand.rm', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatQuickCommandRemoval)
  }
}
