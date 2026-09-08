import { z } from 'zod'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  flattenTerminalQuickCommand,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand,
  normalizeTerminalQuickCommands,
  type TerminalQuickCommandMutation
} from '../../../../shared/terminal-quick-commands'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { MobileWebQuickCommandMutationPayloadSchema } from '../../../../shared/mobile-web/session-quick-command-contract'
import { defineMethod, isStreamingMethod, type RpcContext } from '../core'
import { SESSION_TAB_METHODS } from './session-tabs'

const Scope = z.object({
  worktree: z.string().min(1).max(4096),
  workspaceId: z.string().min(1).max(160)
})
const source = SESSION_TAB_METHODS.find((method) => method.name === 'session.tabs.createTerminal')
if (!source || isStreamingMethod(source)) {
  throw new Error('Missing terminal creation method')
}
const create = source

async function workspaceRepo(context: RpcContext, worktree: string) {
  const snapshot = await context.runtime.listMobileSessionTabs(worktree, context.pairedDeviceId)
  if (`id:${snapshot.worktree}` !== worktree) {
    throw new Error('selector_not_found')
  }
  return snapshot.worktree.startsWith('folder:') ||
    snapshot.worktree === FLOATING_TERMINAL_WORKTREE_ID
    ? null
    : getRepoIdFromWorktreeId(snapshot.worktree)
}

function matches(command: TerminalQuickCommand, repoId: string | null) {
  const scope = getTerminalQuickCommandScope(command)
  return scope.type === 'global' || (repoId !== null && scope.repoId === repoId)
}

function project(commands: TerminalQuickCommand[], repoId: string | null, workspaceId: string) {
  const result = {
    commands: commands
      .filter((command) => matches(command, repoId))
      .map((command) => ({
        ...command,
        scope:
          getTerminalQuickCommandScope(command).type === 'repo'
            ? { type: 'repo' as const, repoId: workspaceId }
            : { type: 'global' as const }
      })),
    totalCount: commands.length,
    repoId: repoId ? workspaceId : null
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) {
    throw new Error('runtime_unavailable')
  }
  return result
}

function mutationForRepo(
  mutation: z.infer<typeof MobileWebQuickCommandMutationPayloadSchema>['mutation'],
  commands: TerminalQuickCommand[],
  repoId: string | null,
  workspaceId: string
): TerminalQuickCommandMutation {
  const id = mutation.type === 'delete' ? mutation.id : mutation.command.id
  const existing = commands.find((command) => command.id === id)
  if ((existing && !matches(existing, repoId)) || (mutation.type === 'delete' && !existing)) {
    throw new Error('invalid_params')
  }
  if (mutation.type === 'delete') {
    return mutation
  }
  const scope =
    mutation.command.scope.type === 'repo'
      ? mutation.command.scope.repoId === workspaceId && repoId
        ? { type: 'repo' as const, repoId }
        : null
      : { type: 'global' as const }
  if (!scope) {
    throw new Error('invalid_params')
  }
  const command = normalizeTerminalQuickCommands([{ ...mutation.command, scope }])[0]
  if (!command) {
    throw new Error('invalid_params')
  }
  return { type: 'upsert', command }
}

export const MOBILE_WEB_SESSION_QUICK_COMMAND_METHODS = [
  defineMethod({
    name: 'mobileWeb.session.quickCommands',
    params: Scope,
    handler: async (params, context) => {
      const repoId = await workspaceRepo(context, params.worktree)
      return project(context.runtime.getClientTerminalQuickCommands(), repoId, params.workspaceId)
    }
  }),
  defineMethod({
    name: 'mobileWeb.session.quickCommandMutate',
    params: Scope.extend({ mutation: MobileWebQuickCommandMutationPayloadSchema.shape.mutation }),
    handler: async (params, context) => {
      const repoId = await workspaceRepo(context, params.worktree)
      if (context.signal?.aborted) {
        throw new Error('runtime_unavailable')
      }
      const mutation = mutationForRepo(
        params.mutation,
        context.runtime.getClientTerminalQuickCommands(),
        repoId,
        params.workspaceId
      )
      return project(
        context.runtime.updateClientTerminalQuickCommands(mutation),
        repoId,
        params.workspaceId
      )
    }
  }),
  defineMethod({
    name: 'mobileWeb.session.createQuickCommand',
    params: Scope.extend({
      commandId: z.string().min(1).max(128),
      clientMutationId: z.string().min(1).max(128),
      timeoutMs: z.number().int().min(1).max(15_000)
    }),
    handler: async (params, context) => {
      const deadline = Date.now() + params.timeoutMs
      const checkDispatch = () => {
        if (context.signal?.aborted || Date.now() >= deadline) {
          throw new Error('runtime_unavailable')
        }
      }
      checkDispatch()
      const repoId = await workspaceRepo(context, params.worktree)
      const command = context.runtime
        .getClientTerminalQuickCommands()
        .find((candidate) => candidate.id === params.commandId && matches(candidate, repoId))
      if (!command) {
        throw new Error('invalid_params')
      }
      const input: Record<string, unknown> = {
        worktree: params.worktree,
        activate: true,
        select: true,
        navigation: 'caller',
        clientMutationId: params.clientMutationId
      }
      let initialInput: { text: string; enter: false; successToast: string } | null = null
      if (isTerminalAgentQuickCommand(command)) {
        if (
          !(await context.runtime.getMobileSessionAgentOptions(params.worktree)).includes(
            command.agent
          )
        ) {
          throw new Error('invalid_params')
        }
        input.agent = command.agent
        input.agentPrompt = command.prompt
      } else if (command.appendEnter) {
        input.command = flattenTerminalQuickCommand(command).command
        input.startupCommandDelivery = 'shell-ready'
      } else {
        initialInput = {
          text: command.command,
          enter: false,
          successToast: `${command.label.trim() || 'Quick command'} inserted`
        }
      }
      checkDispatch()
      const result = await create.handler(create.params!.parse(input), context)
      const parsed = z.object({ tab: z.object({ id: z.string().min(1).max(512) }) }).parse(result)
      return { workspaceId: params.workspaceId, tabId: parsed.tab.id, created: true, initialInput }
    }
  })
]
