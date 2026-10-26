import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { every } from './connector-background.js'
import type { ConnectorAdapter } from './connector-adapter.js'
import type { ConnectorCore } from './connector-core.js'
import type { MachineEnv } from './machine-auth.js'
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
  const installs = new SlackInstalls(config.tokenKey)
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

  // Slack's own requests: signed over the raw body, size-capped.
  const fromSlack = (
    app: Hono<MachineEnv>,
    path: string,
    handle: (context: Context<MachineEnv>, rawBody: string) => Promise<Response>
  ) =>
    app.post(
      path,
      bodyLimit({
        maxSize: MAX_SLACK_BODY_BYTES,
        onError: (context) => context.json({ error: 'request_too_large' }, 413)
      }),
      async (context) => {
        const rawBody = await context.req.text()
        const verified = verifySlackSignature({
          signingSecret: config.signingSecret,
          timestamp: context.req.header('x-slack-request-timestamp'),
          signature: context.req.header('x-slack-signature'),
          rawBody,
          nowMs: now()
        })
        return verified
          ? await handle(context, rawBody)
          : context.json({ error: 'invalid_signature' }, 401)
      }
    )

  function registerRoutes(
    app: Hono<MachineEnv>,
    core: Pick<ConnectorCore, 'route' | 'answerCard' | 'notify'>
  ) {
    fromSlack(app, '/slack/events', async (context, rawBody) => {
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
      if (envelope.kind === 'message' && config.teamIds.has(envelope.message.teamId)) {
        const install = await installs.find(database, envelope.message.teamId)
        if (install && envelope.message.userId !== install.botUserId) {
          await core.route(inboundSlackMessage(envelope.message, install, config.paused))
        }
      }
      return context.body(null, 200)
    })

    // Answer presses on prompt cards; answered before any Slack call, like events.
    fromSlack(app, '/slack/interactivity', async (context, rawBody) => {
      const click = readSlackClick(rawBody)
      if (click === 'invalid') {
        return context.json({ error: 'invalid_request' }, 400)
      }
      if (click !== 'ignored' && config.teamIds.has(click.teamId)) {
        const install = await installs.find(database, click.teamId)
        if (install) {
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
      }
      return context.body(null, 200)
    })
  }

  return {
    adapter,
    members,
    registerRoutes,
    startBackground: () =>
      every('slack_members', MEMBER_CHECK_INTERVAL_MS, () => members.checkContextAuthors())
  }
}
