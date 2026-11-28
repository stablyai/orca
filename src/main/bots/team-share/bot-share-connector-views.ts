// What a teammate reads of the shared agent's connectors: which ones it has, where, and whether they
// work. Each view is built field by field from an allowlist, never by trimming the owner's answer, so a
// field the cloud or host adds later never reaches a teammate unread. No secret, app id, install or
// sign-in link, or other agent's id is on any list.
import type { Bot } from '../../../shared/bot-types'
import type { BotOwnTool, BotTools } from '../../../shared/bot-tools'
import type { BotToolSignInStatus } from '../../../shared/bot-tool-sign-in'
import type { ComposioStatus } from '../../../shared/composio/composio-apps'
import type {
  ConnectorBotSlackState,
  ConnectorBotSlackStateResponse
} from '../../../shared/connector-bot-slack-contract'
import type { ConnectorLinearState } from '../../../shared/connector-bot-linear-contract'
import type { ConnectorGitHubState } from '../../../shared/connector-bot-github-contract'
import type {
  GoogleAccountView,
  GoogleStatusView
} from '../../../shared/google/google-connect-types'

/** Another agent's id reads as none, so a teammate never learns of the owner's other agents. */
const onlyShared = (botId: string | null, sharedBotId: string): string | null =>
  botId === sharedBotId ? botId : null

function slackState(state: ConnectorBotSlackState): ConnectorBotSlackState {
  switch (state.state) {
    case 'not_created':
      return { state: 'not_created' }
    case 'uncertain':
    case 'grant_expired':
      return { state: state.state, teamId: state.teamId }
    case 'created':
      return {
        state: 'created',
        teamId: state.teamId,
        appId: state.appId,
        oauthFailure: state.oauthFailure
      }
    case 'installed':
      return {
        state: 'installed',
        teamId: state.teamId,
        appId: state.appId,
        botUserId: state.botUserId,
        installerUserId: state.installerUserId,
        teamName: state.teamName,
        installerName: state.installerName,
        updateNeeded: state.updateNeeded,
        updateAvailable: state.updateAvailable,
        postAs: state.postAs,
        postAsPending: state.postAsPending,
        poster: state.poster
          ? { name: state.poster.name, avatarUrl: state.poster.avatarUrl }
          : undefined,
        computerName: state.computerName
      }
  }
}

export function botShareSlackState(
  state: ConnectorBotSlackStateResponse
): ConnectorBotSlackStateResponse {
  return { ...slackState(state), ...(state.teams ? { teams: state.teams.map(slackState) } : {}) }
}

export function botShareLinearState(
  state: ConnectorLinearState,
  sharedBotId: string
): ConnectorLinearState {
  return {
    installUrl: '',
    workspaces: state.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      urlKey: workspace.urlKey,
      installed: workspace.installed,
      userId: workspace.userId,
      userName: workspace.userName,
      defaultBotId: onlyShared(workspace.defaultBotId, sharedBotId)
    }))
  }
}

export function botShareGitHubState(
  state: ConnectorGitHubState,
  sharedBotId: string
): ConnectorGitHubState {
  return {
    installUrl: '',
    account: state.account ? { userId: state.account.userId, login: state.account.login } : null,
    ...(state.accounts
      ? {
          accounts: state.accounts.map((account) => ({
            userId: account.userId,
            login: account.login,
            installations: [...account.installations],
            defaultBotId: onlyShared(account.defaultBotId, sharedBotId)
          }))
        }
      : {}),
    installations: state.installations.map((installation) => ({
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      repositories:
        installation.repositories?.map((repository) => ({ fullName: repository.fullName })) ?? null
    })),
    defaultBotId: onlyShared(state.defaultBotId, sharedBotId)
  }
}

/** An account by its label and which services work: not the app it signed in through, Google's own
 *  words, or a link to turn an API on (both name the owner's Cloud project). */
function googleAccount(account: GoogleAccountView): GoogleAccountView {
  return {
    email: account.email,
    status: account.status,
    services: account.services.map((service) => ({
      service: service.service,
      state: service.state
    })),
    checkedAt: account.checkedAt,
    connectedAt: account.connectedAt
  }
}

/** Read as the shared agent itself reads it (only its accounts), without the app's identity or key. */
export function botShareGoogleStatus(view: GoogleStatusView, sharedBot: Bot): GoogleStatusView {
  return {
    client: view.client ? { clientId: '', source: view.client.source, savedAt: 0 } : null,
    accounts: view.accounts.map(googleAccount),
    defaultAccount: view.defaultAccount,
    bots: view.bots
      .filter((bot) => bot.id === sharedBot.id)
      .map((bot) => ({ id: bot.id, name: bot.name, accounts: bot.accounts?.slice() }))
  }
}

export function botShareComposioStatus(status: ComposioStatus): ComposioStatus {
  return {
    key: status.key,
    limit: status.limit ? { retryAt: status.limit.retryAt } : null,
    added: status.added
  }
}

function toolSignIn(signIn: BotToolSignInStatus): BotToolSignInStatus {
  return signIn.state === 'signed-in'
    ? { state: 'signed-in', limited: signIn.limited }
    : { state: signIn.state, problem: signIn.problem }
}

/** A tool by name and sign-in state: its URL or command line may carry a key. */
function ownTool(tool: BotOwnTool): BotOwnTool {
  return {
    name: tool.name,
    detail: '',
    remote: tool.remote,
    signIn: tool.signIn ? toolSignIn(tool.signIn) : undefined
  }
}

export function botShareTools(tools: BotTools): BotTools {
  return {
    agent: tools.agent,
    own: tools.own.map(ownTool),
    inherited: tools.inherited.map((tool) => ({ name: tool.name, plugin: tool.plugin })),
    hostMcpServers: tools.hostMcpServers
  }
}

/** A cloud answer with its value seen through `view`; a refusal passes as it came. */
export function viewedAnswer<T>(
  answer: { ok: true; value: T } | { ok: false; error: string },
  view: ((value: T) => T) | undefined
): { ok: true; value: T } | { ok: false; error: string } {
  return answer.ok && view ? { ok: true, value: view(answer.value) } : answer
}
