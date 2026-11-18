import { z } from 'zod'

// Every route is POST except hello and a bot's avatar (PUT), a bot's Slack state (GET) and the DELETEs, with `Authorization: Bearer <connector token>`: the 5-minute
// token Orca's auth service mints for a signed-in machine. The machine is that token's (sub, mid), the
// user and the per-install machine id. A 401 means fetch a new token and try again.
export const CONNECTOR_PATHS = {
  hello: '/v1/connector/hello',
  poll: '/v1/connector/poll',
  acks: '/v1/connector/acks',
  events: '/v1/connector/events',
  replies: '/v1/connector/replies',
  // POST one shared verb a bot takes in a source (action-messages.ts), or asks what it can take.
  actions: '/v1/connector/actions',
  // DELETE `${slackGrants}/<team id>` forgets one.
  slackGrants: '/v1/connector/slack/grants',
  // `${bots}/<bot id>/slack`: GET its Slack state, DELETE its install. POST `…/slack/apps` creates
  // or resumes its Slack app and answers the link that installs it. GET `…/slack/members?q=` lists
  // the installed app's workspace's full members whose names match, for the bot's Who can ask.
  // POST `…/posts` posts as the bot. PUT `…/avatar` sets the bot's picture, which its app's icon follows.
  // POST `…/linear/comments` comments on a Linear issue as the bot.
  bots: '/v1/connector/bots',
  // PUT one page of a machine's bots (hello-messages.ts), from a cloud listing `bots.pages`.
  botPages: '/v1/connector/bot-pages',
  // POST `${linear}/connect` starts a one-trip sign-in (connect-messages.ts) and
  // `…/connect/redeem` links whom it proved; GET `…/state` lists the linked workspaces; DELETE
  // `…/workspaces/<id>` unlinks.
  // GET `…/workspaces/<id>/members?q=` finds its members by name; PUT `…/workspaces/<id>/default-bot`
  // sets the bot the user's requests there go to.
  linear: '/v1/connector/linear',
  // POST `${github}/connect` and `…/connect/redeem`, as for Linear. GET `${github}/state`; DELETE
  // `…/link` unlinks; PUT `…/default-bot` sets the bot the user's requests go to; GET
  // `…/users?q=<username>` finds a GitHub user by exact login, for a bot's Who can ask.
  github: '/v1/connector/github',
  // GET lists the account's pending access requests; POST `…/redeem` opens one from its link; POST
  // `…/<request id>/decision` closes one.
  accessRequests: '/v1/connector/access-requests'
} as const

export const CONNECTOR_ERROR_CODES = [
  'invalid_token',
  'hello_required',
  // A hello's botPages named a page the cloud doesn't hold: stage them all again.
  'bot_pages_missing',
  'request_too_large',
  'client_too_old',
  'not_this_hosts_thread',
  // Slack refused the config token, or the account has none for that workspace: paste a new one.
  'grant_expired',
  'slack_unavailable',
  // No bot by that id among the account's machines' hellos.
  'unknown_bot',
  // The bot's app lives in another Slack workspace than the one asked for.
  'wrong_workspace',
  // Slack refused to create or configure the app; the message says why.
  'slack_refused',
  // The bot has no Slack install to read its workspace through.
  'not_installed'
] as const
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number]

// Codes stay open so an older machine reads a newer one as a plain failure.
export const ConnectorErrorResponseSchema = z.object({ error: z.string().min(1) })
