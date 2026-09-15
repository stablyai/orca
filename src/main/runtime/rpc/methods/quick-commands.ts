import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  buildTerminalQuickCommandCreate,
  buildTerminalQuickCommandUpdate,
  filterTerminalQuickCommandsByScope,
  findTerminalQuickCommand,
  type TerminalQuickCommandScopeFilter
} from '../../../../shared/terminal-quick-command-mutations'
import { terminalQuickCommandMatchesRepo } from '../../../../shared/terminal-quick-commands'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { defineMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const QuickCommandTarget = {
  repo: OptionalString,
  worktree: OptionalString
}

const QuickCommandBody = {
  action: z.enum(['terminal-command', 'agent-prompt']).optional(),
  command: OptionalString,
  prompt: OptionalString,
  agent: OptionalString,
  appendEnter: z.boolean().optional()
}

const QuickCommandList = z.object({
  ...QuickCommandTarget,
  scope: z.enum(['all', 'global', 'repo', 'applicable']).optional()
})

const QuickCommandSelector = z.object({
  id: requiredString('Missing quick command id')
})

const QuickCommandCreate = z.object({
  ...QuickCommandTarget,
  ...QuickCommandBody,
  id: OptionalString,
  label: requiredString('Missing quick command label')
})

const QuickCommandUpdate = z.object({
  ...QuickCommandTarget,
  ...QuickCommandBody,
  id: requiredString('Missing quick command id'),
  label: OptionalString,
  global: z.boolean().optional()
})

type QuickCommandRuntime = {
  getClientTerminalQuickCommands(): TerminalQuickCommand[]
  updateClientTerminalQuickCommands(
    mutation:
      | { type: 'upsert'; command: TerminalQuickCommand }
      | { type: 'delete'; id: string }
  ): TerminalQuickCommand[]
  showRepo(selector: string): Promise<{ id: string }>
  showManagedWorktree(selector: string): Promise<{ repoId: string }>
}

async function resolveRepoId(
  runtime: QuickCommandRuntime,
  args: { repo?: string; worktree?: string }
): Promise<string | null> {
  if (args.repo) {
    return (await runtime.showRepo(args.repo)).id
  }
  if (args.worktree) {
    return (await runtime.showManagedWorktree(args.worktree)).repoId
  }
  return null
}

function requireQuickCommand(runtime: QuickCommandRuntime, id: string): TerminalQuickCommand {
  const command = findTerminalQuickCommand(runtime.getClientTerminalQuickCommands(), id)
  if (!command) {
    throw new Error('quick_command_not_found')
  }
  return command
}

function listByScope(
  commands: TerminalQuickCommand[],
  scope: TerminalQuickCommandScopeFilter,
  repoId: string | null
): TerminalQuickCommand[] {
  if (scope === 'all') {
    return commands
  }
  if (scope === 'global') {
    return filterTerminalQuickCommandsByScope(commands, { type: 'global' })
  }
  if (repoId === null) {
    throw new Error('quick_command_repo_required')
  }
  // Why: `repo` is only that repo's commands; `applicable` is what a workspace
  // actually shows, which also includes the global ones.
  return scope === 'repo'
    ? filterTerminalQuickCommandsByScope(commands, { type: 'repo', repoId })
    : commands.filter((command) => terminalQuickCommandMatchesRepo(command, repoId))
}

export const QUICK_COMMAND_METHODS = [
  defineMethod({
    name: 'quickCommand.list',
    params: QuickCommandList,
    handler: async (params, { runtime }) => {
      const host = runtime as unknown as QuickCommandRuntime
      const repoId = await resolveRepoId(host, params)
      const commands = host.getClientTerminalQuickCommands()
      const scope = params.scope ?? (repoId === null ? 'all' : 'applicable')
      return { quickCommands: listByScope(commands, scope, repoId), repoId }
    }
  }),
  defineMethod({
    name: 'quickCommand.show',
    params: QuickCommandSelector,
    handler: (params, { runtime }) => ({
      quickCommand: requireQuickCommand(runtime as unknown as QuickCommandRuntime, params.id)
    })
  }),
  defineMethod({
    name: 'quickCommand.create',
    params: QuickCommandCreate,
    handler: async (params, { runtime }) => {
      const host = runtime as unknown as QuickCommandRuntime
      const repoId = await resolveRepoId(host, params)
      const command = buildTerminalQuickCommandCreate(
        { ...params, scope: repoId === null ? { type: 'global' } : { type: 'repo', repoId } },
        () => `quick-command-${randomUUID()}`
      )
      if (findTerminalQuickCommand(host.getClientTerminalQuickCommands(), command.id)) {
        throw new Error('quick_command_id_taken')
      }
      const quickCommands = host.updateClientTerminalQuickCommands({ type: 'upsert', command })
      return { quickCommand: command, quickCommands }
    }
  }),
  defineMethod({
    name: 'quickCommand.update',
    params: QuickCommandUpdate,
    handler: async (params, { runtime }) => {
      const host = runtime as unknown as QuickCommandRuntime
      const { id, repo, worktree, global: makeGlobal, ...patch } = params
      const repoId = await resolveRepoId(host, { repo, worktree })
      const command = buildTerminalQuickCommandUpdate(requireQuickCommand(host, id), {
        ...patch,
        // Why: scope only moves when the caller asked — an omitted repo/global
        // must not silently demote a repo-scoped command to global.
        scope:
          repoId !== null ? { type: 'repo', repoId } : makeGlobal ? { type: 'global' } : undefined
      })
      const quickCommands = host.updateClientTerminalQuickCommands({ type: 'upsert', command })
      return { quickCommand: command, quickCommands }
    }
  }),
  defineMethod({
    name: 'quickCommand.rm',
    params: QuickCommandSelector,
    handler: (params, { runtime }) => {
      const host = runtime as unknown as QuickCommandRuntime
      const removed = requireQuickCommand(host, params.id)
      const quickCommands = host.updateClientTerminalQuickCommands({
        type: 'delete',
        id: params.id
      })
      return { removed, quickCommands }
    }
  })
]
