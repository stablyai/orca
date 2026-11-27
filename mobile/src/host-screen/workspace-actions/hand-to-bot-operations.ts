// Hand to bot… on the phone: the desktop's move under the bot's home, then bots.takeOver, through the
// shared sequence that puts the workspace back when the bot can't take it.
import * as z from 'zod'
import { formatAgentTypeLabel } from '../../../../src/shared/agent-status/presentation/agent-type-label'
import {
  handOverWorkspace,
  type HandOverOutcome
} from '../../../../src/shared/bots/hand-over-workspace'
import type { RpcSendParams } from '../../../../src/shared/rpc-contract/rpc-send-params'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../src/shared/workspace/identity/workspace-scope'
import type { ListedBot } from '../../bots/host-bots-operations'
import { translate } from '../../i18n/mobile-i18n'
import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

const worktreeParentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-parent',
    method: 'worktree.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('parent-written', z.unknown())
  })
)

const botTakeOver = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.take-over',
    method: 'bots.takeOver',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('taken-over', z.looseObject({ sessionId: z.string().min(1) }))
  })
)

type ParentFields = Pick<
  RpcSendParams<'worktree.set'>,
  'parentWorktree' | 'crossStoreParent' | 'noParent'
>

/** Where the workspace sits now, so a hand-over the bot refused can put it back. */
function placementOf(row: Worktree): ParentFields {
  const folder = row.workspaceLineage?.parentWorkspaceKey
  if (folder) {
    return { parentWorktree: `id:${folder}` }
  }
  if (row.parentWorktreeId) {
    return { parentWorktree: `id:${row.parentWorktreeId}` }
  }
  return row.crossStoreParent
    ? { crossStoreParent: row.crossStoreParent.parent }
    : { noParent: true }
}

const hostOf = (row: Worktree) => row.hostId ?? LOCAL_EXECUTION_HOST_ID

/** The workspace's name, as its row menu says it. */
export function handToBotName(row: Worktree): string {
  return row.displayName || row.repo
}

/** The bot whose home the workspace sits under, through any parent workspaces between. */
export function handToBotOwner<B extends Pick<ListedBot, 'folderWorkspaceId'>>(
  row: Worktree,
  rows: readonly Worktree[],
  bots: readonly B[]
): B | null {
  const seen = new Set<string>()
  let current: Worktree | undefined = row
  while (current && !seen.has(current.worktreeId)) {
    seen.add(current.worktreeId)
    const folder: string | undefined = current.workspaceLineage?.parentWorkspaceKey
    const parentId: string | null | undefined = folder ?? current.parentWorktreeId
    const bot =
      folder && bots.find((entry) => folderWorkspaceKey(entry.folderWorkspaceId) === folder)
    if (bot) {
      return bot
    }
    current = parentId
      ? rows.find((entry) => entry.worktreeId === parentId && hostOf(entry) === hostOf(row))
      : undefined
  }
  return null
}

/** The workspace's agents, as its card names them; they keep running and work for the bot. */
export function handToBotAgents(row: Worktree): string[] {
  return (row.agents ?? []).map((agent) => formatAgentTypeLabel(agent.agentType))
}

/** Why a hand-over didn't happen, and where that left the workspace, in the desktop's words. */
export function handToBotFailureLine(
  outcome: Extract<HandOverOutcome, { ok: false }>,
  name: string,
  bot: string
): string {
  const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
  if (outcome.stage === 'move') {
    return reason
  }
  return outcome.placement === 'restored'
    ? translate('bots.handToBot.putBack', '{{reason}} {{name}} stayed where it was.', {
        reason,
        name
      })
    : outcome.placement === 'moved-since'
      ? translate('bots.handToBot.movedSince', '{{reason}} {{name}} stays where you moved it.', {
          reason,
          name
        })
      : translate(
          'bots.handToBot.leftMoved',
          '{{reason}} {{name}} is under {{bot}} now; move it back from its menu.',
          { reason, name, bot }
        )
}

/** Moves the workspace under the bot's home, then tells the bot in `chat`. */
export function handWorkspaceToBot(args: {
  client: RpcClient
  row: Worktree
  bot: Pick<ListedBot, 'id' | 'folderWorkspaceId'>
  chat: 'home' | 'new'
  goal: string
}): Promise<HandOverOutcome> {
  const { client, row, bot, chat } = args
  const worktree = `id:${row.worktreeId}`
  const home = folderWorkspaceKey(bot.folderWorkspaceId)
  const before = placementOf(row)
  const goal = args.goal.trim()
  let refusal: unknown
  return handOverWorkspace({
    move: async () => {
      worktreeParentWrite.interpret(
        await worktreeParentWrite.request(client, { worktree, parentWorktree: `id:${home}` })
      )
    },
    notify: async () => {
      const reply = await botTakeOver
        .request(client, {
          botId: bot.id,
          chat,
          takeOver: {
            workspace: {
              id: row.worktreeId,
              name: handToBotName(row),
              ...(row.repo ? { project: row.repo } : {})
            },
            agents: handToBotAgents(row),
            ...(goal ? { goal } : {})
          }
        })
        .catch((error: unknown) => {
          refusal = error
          throw error
        })
      return botTakeOver.interpret(reply).sessionId
    },
    // Only while it is still under the bot's home: a move the owner made meanwhile stands. An
    // unanswered notice may have reached the bot, which then works there, so it stays.
    restore: async () => {
      if (isRpcDeliveryUnknown(refusal)) {
        throw refusal
      }
      worktreeParentWrite.interpret(
        await worktreeParentWrite.request(client, { worktree, ...before, ifParentWorkspace: home })
      )
    }
  })
}
