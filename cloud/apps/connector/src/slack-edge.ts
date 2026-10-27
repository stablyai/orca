import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { every } from './connector-background.js'
import type { ConnectorAdapter } from './connector-adapter.js'
import type { ConnectorCore } from './connector-core.js'
import type { MachineEnv } from './machine-auth.js'
import { RateLimiter } from './rate-limiter.js'
import { SlackApps } from './slack-apps.js'
import { readSlackClick } from './slack-clicks.js'
import type { SlackConfig } from './slack-config.js'
import { inboundSlackMessage, readSlackEnvelope } from './slack-events.js'
import { SlackInstalls } from './slack-installs.js'
import { SlackMembers } from './slack-members.js'
import { slackNotice } from './slack-notices.js'
import { SlackPostSender } from './slack-post-sender.js'
import { isOpenSlackCard, settledSlackCard, slackCard } from './slack-prompt-cards.js'
import { verifySlackSignature } from './slack-signature.js'
import { statusText } from './connector-copy.js'
import { escapeSlackText, slackText } from './slack-text.js'
import { SlackThreadHistory } from './slack-thread-history.js'
import { createSlackWebApi, type SlackWebApi } from './slack-web-api.js'

// Slack's payloads can carry blocks and files well past the machine API's limit.
const MAX_SLACK_BODY_BYTES = 1024 * 1024
const MEMBER_CHECK_INTERVAL_MS = 5_000
// Per instance, after the signature: what one app's own owners can make us do.
const VERIFIED_PER_MINUTE_PER_APP = 600

export type SlackEdge = ReturnType<typeof createSlackEdge>

// Slack in and out: signed ingress for events and answer presses, and the adapter that formats and
// sends the shared core's posts, reads threads and checks members.
export function createSlackEdge(deps: {
  config: SlackConfig
  database: CloudDatabase
  now: () => number
  api?: SlackWebApi
}) {
  const { config, database, now } = deps
  const apps = new SlackApps(config.tokenKey)
  const installs = new SlackInstalls(config.tokenKey)
  const appRequests = new RateLimiter(VERIFIED_PER_MINUTE_PER_APP, now)
  const api = deps.api ?? createSlackWebApi()
  const members = new SlackMembers({ database, installs, api, now })
  const history = new SlackThreadHistory({ database, installs, members, api })
  const sender = new SlackPostSender({ database, installs, api })

  const adapter: ConnectorAdapter = {
    source: 'slack',
    agentText: (text) => ({ text: escapeSlackText(text) }),
    notice: slackNotice,
    seen: (_place, messageId) => ({ name: 'eyes', timestamp: messageId }),
    status: (view) => ({ text: statusText(slackText, view) }),
    card: slackCard,
    isOpenCard: isOpenSlackCard,
    settledCard: settledSlackCard,
    teammateContext: slackText.teammateContext,
    send: (post) => sender.send(post),
    heldStartPrompt: (start) => history.heldStartPrompt(start),
    trustedNames: (transaction, teamId, userIds) =>
      members.trustedNames(transaction, teamId, userIds)
  }

  // Which workspaces a verified request may act in: those its app is installed in, or for the legacy
  // env-secret route, the allowlisted ones whatever their app.
  type Scope = { appId: string } | { legacyTeams: ReadonlySet<string> }
  type Verified = (context: Context<MachineEnv>, rawBody: string, scope: Scope) => Promise<Response>

  // The request's own install, if its scope reaches it; anything else is acknowledged and ignored.
  const installIn = async (scope: Scope, appId: string, teamId: string) => {
    const install = await installs.find(database, teamId)
    if (!install) {
      return null
    }
    return 'appId' in scope
      ? appId === scope.appId && install.appId === scope.appId
        ? install
        : null
      : scope.legacyTeams.has(teamId)
        ? install
        : null
  }

  // Slack's requests, signed over the raw body, size-capped. Nothing in the body is read before the
  // signature checks out; on an app's own URL the path only picks which secret it must match.
  const fromSlack = (
    app: Hono<MachineEnv>,
    path: string,
    limitClient: MiddlewareHandler,
    verifier: (context: Context<MachineEnv>) => Promise<{ secret: string; scope: Scope } | null>,
    handle: Verified
  ) =>
    app.post(
      path,
      limitClient,
      bodyLimit({
        maxSize: MAX_SLACK_BODY_BYTES,
        onError: (context) => context.json({ error: 'request_too_large' }, 413)
      }),
      async (context) => {
        const rawBody = await context.req.text()
        const key = await verifier(context)
        const verified =
          key !== null &&
          verifySlackSignature({
            signingSecret: key.secret,
            timestamp: context.req.header('x-slack-request-timestamp'),
            signature: context.req.header('x-slack-signature'),
            rawBody,
            nowMs: now()
          })
        if (!key || !verified) {
          return context.json({ error: 'invalid_signature' }, 401)
        }
        if ('appId' in key.scope && !appRequests.allow(key.scope.appId)) {
          return context.json({ error: 'rate_limited' }, 429)
        }
        return await handle(context, rawBody, key.scope)
      }
    )

  function registerRoutes(
    app: Hono<MachineEnv>,
    core: Pick<ConnectorCore, 'route' | 'answerCard' | 'notify'>,
    limitClient: MiddlewareHandler
  ) {
    const events: Verified = async (context, rawBody, scope) => {
      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        return context.json({ error: 'invalid_request' }, 400)
      }
      const envelope = readSlackEnvelope(payload)
      if (envelope.kind === 'invalid') {
        return context.json({ error: 'invalid_request' }, 400)
      }
      if (envelope.kind === 'url_verification') {
        return context.json({ challenge: envelope.challenge })
      }
      // Answered before any Slack call; a database failure is a 500, so Slack retries.
      if (envelope.kind === 'message') {
        const { message } = envelope
        const install = await installIn(scope, message.appId, message.teamId)
        if (install && message.userId !== install.botUserId) {
          await core.route(inboundSlackMessage(message, install, config.paused))
        }
      }
      return context.body(null, 200)
    }

    // Answer presses on prompt cards; answered before any Slack call, like events.
    const interactivity: Verified = async (context, rawBody, scope) => {
      const click = readSlackClick(rawBody)
      if (click === 'invalid') {
        return context.json({ error: 'invalid_request' }, 400)
      }
      const install = click === 'ignored' ? null : await installIn(scope, click.appId, click.teamId)
      if (click !== 'ignored' && install) {
        const reply = await core.answerCard('slack', {
          workspaceId: click.teamId,
          channelId: click.channelId,
          messageRef: click.messageTs,
          userId: click.userId,
          optionId: click.optionId,
          paused: config.paused || install.paused
        })
        if (reply) {
          await core.notify('slack', reply)
        }
      }
      return context.body(null, 200)
    }

    const ownApp = async (context: Context<MachineEnv>) => {
      const appId = context.req.param('appId') ?? ''
      const secret = await apps.signingSecret(database, appId)
      return secret === null ? null : { secret, scope: { appId } }
    }
    fromSlack(app, '/slack/apps/:appId/events', limitClient, ownApp, events)
    fromSlack(app, '/slack/apps/:appId/interactivity', limitClient, ownApp, interactivity)

    const { legacy } = config
    if (legacy) {
      const legacyKey = async () => ({
        secret: legacy.signingSecret,
        scope: { legacyTeams: legacy.teamIds }
      })
      fromSlack(app, '/slack/events', limitClient, legacyKey, events)
      fromSlack(app, '/slack/interactivity', limitClient, legacyKey, interactivity)
    }
  }

  return {
    adapter,
    members,
    registerRoutes,
    startBackground: () =>
      every('slack_members', MEMBER_CHECK_INTERVAL_MS, () => members.checkContextAuthors())
  }
}
