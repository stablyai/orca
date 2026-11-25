// What a teammate reads of the shared agent's connectors: which ones it has and where, never a secret
// or a handle that acts (install or sign-in links, key checks), nor another agent's settings.
import type { Bot } from '../../../shared/bot-types'
import type { BotTools } from '../../../shared/bot-tools'
import type { ConnectorLinearState } from '../../../shared/connector-bot-linear-contract'
import type { ConnectorGitHubState } from '../../../shared/connector-bot-github-contract'
import type { GoogleStatusView } from '../../../shared/google/google-connect-types'

/** Another agent's id reads as none, so a teammate never learns of the owner's other agents. */
const onlyShared = (botId: string | null, sharedBotId: string): string | null =>
  botId === sharedBotId ? botId : null

export function botShareLinearState(
  state: ConnectorLinearState,
  sharedBotId: string
): ConnectorLinearState {
  return {
    installUrl: '',
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      defaultBotId: onlyShared(workspace.defaultBotId, sharedBotId)
    }))
  }
}

export function botShareGitHubState(
  state: ConnectorGitHubState,
  sharedBotId: string
): ConnectorGitHubState {
  return {
    ...state,
    installUrl: '',
    ...(state.accounts
      ? {
          accounts: state.accounts.map((account) => ({
            ...account,
            defaultBotId: onlyShared(account.defaultBotId, sharedBotId)
          }))
        }
      : {}),
    defaultBotId: onlyShared(state.defaultBotId, sharedBotId)
  }
}

/** Read as the shared agent itself reads it (only its accounts), without the app's key or its check. */
export function botShareGoogleStatus(view: GoogleStatusView, sharedBot: Bot): GoogleStatusView {
  const { clientKey: _clientKey, ...rest } = view
  return {
    ...rest,
    client: view.client
      ? { clientId: '', source: view.client.source, savedAt: view.client.savedAt }
      : null,
    bots: view.bots.filter((bot) => bot.id === sharedBot.id)
  }
}

/** A tool's URL or command line may carry a key, so only its name and sign-in state are read. */
export function botShareTools(tools: BotTools): BotTools {
  return { ...tools, own: tools.own.map((tool) => ({ ...tool, detail: '' })) }
}

/** A cloud answer with its value seen through `view`; a refusal passes as it came. */
export function viewedAnswer<T>(
  answer: { ok: true; value: T } | { ok: false; error: string },
  view: ((value: T) => T) | undefined
): { ok: true; value: T } | { ok: false; error: string } {
  return answer.ok && view ? { ok: true, value: view(answer.value) } : answer
}
