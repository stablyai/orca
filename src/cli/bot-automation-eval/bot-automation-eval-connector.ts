// The stand-in host's connector actions and webhooks: what a bot reaches Slack, Linear and GitHub
// through as itself, and the hooks its automations made.
import { automationWebhookTrigger } from '../../shared/automation-event-triggers'
import { hookIdOfRule } from '../../shared/connector-webhook-contract'
import { botLinearWorkspaces } from '../../shared/bot-types'
import { ConnectorActionArgs } from '../../shared/connector-action-contract'
import { RuntimeClientError } from '../runtime/connection/types'
import type { WebhookSummary } from '../../shared/rpc-contract/webhooks-params'
import type { StandInIo } from '../bot-orchestration-eval/bot-orchestration-eval-orca'
import type { EvalHostState } from './bot-automation-eval-host'
import { hasLinear, placeMatches, resolvePlace } from './bot-automation-eval-connector-places'
import { linearIssue, readLinearIssue, searchLinear } from './bot-automation-eval-linear'
import { createIssue, setIssue } from './bot-automation-eval-connector-linear'
import { change, downloadFile, messagesAt } from './bot-automation-eval-connector-messages'
import { findSlackPerson, OWNER_SLACK_ID, SLACK_WORKSPACE } from './bot-automation-eval-slack'
import { searchSlack } from './bot-automation-eval-slack-search'
import { isStaging, serveWakingThread, STAGED } from './bot-automation-eval-waking-thread'

const VERBS = [
  'find',
  'check',
  'read',
  'post',
  'react',
  'edit',
  'delete',
  'attach',
  'places'
] as const

// As Orca Cloud answers: one entry per connected source, whatever its workspaces; Linear's find
// searches a team's or workspace's issues.
export function capabilities(state: EvalHostState) {
  const bot = state.bots[0]
  const verbs = Object.fromEntries(VERBS.map((verb) => [verb, { status: 'yes', actor: 'bot' }]))
  const linearVerbs = {
    ...verbs,
    set: {
      status: 'yes',
      actor: 'bot',
      reason: "Sets an issue's state, assignee, delegate, priority, labels and estimate by name."
    },
    post: {
      status: 'yes',
      actor: 'bot',
      reason: 'With --title, a post to a team makes a new issue there (a sub-issue with --parent).',
      limits: { create: true }
    },
    find: {
      status: 'yes',
      actor: 'bot',
      reason:
        "Finds an issue by key (ENG-42) or link, a team or workspace by key or name, and searches a team's or workspace's issues.",
      limits: { search: ['text', 'state', 'assignee', 'label'] }
    }
  }
  const slackVerbs = {
    ...verbs,
    find: {
      status: 'yes',
      actor: 'bot',
      reason:
        'Channels by #name, link or id; people by @name or user:<id> (title, email, time zone); searches the workspace by words, as the person a run answers.',
      limits: { search: ['text'] }
    }
  }
  return [
    ...(bot?.slack ? [{ source: 'slack', verbs: slackVerbs }] : []),
    ...(hasLinear(state) ? [{ source: 'linear', verbs: linearVerbs }] : []),
    ...(bot?.github ? [{ source: 'github', verbs }] : [])
  ]
}

// As Orca Cloud lists them: each workspace, then the places in it that are workspace-scoped refs.
export function workspaces(state: EvalHostState) {
  const bot = state.bots[0]
  const inside = (workspaceRef: string) => {
    const prefix = workspaceRef.replace(/workspace$/, '')
    return (state.places ?? []).filter(
      (place) => place.ref.startsWith(prefix) && place.ref !== workspaceRef
    )
  }
  return [
    ...(bot?.slack ? [{ source: 'slack', ...SLACK_WORKSPACE }] : []),
    ...(bot ? botLinearWorkspaces(bot) : []).map((workspace) => {
      const ref = `linear:${workspace.workspaceId}:workspace`
      return { source: 'linear', ref, label: workspace.workspaceName, places: inside(ref) }
    }),
    ...(bot?.github ? [{ source: 'github', ref: 'github:eval:workspace', label: 'eval' }] : [])
  ]
}

const NO_LINEAR = {
  ok: false,
  refusal: 'invalid_args',
  message: 'Search a Linear team or workspace: pass its key, name or ref.'
}

// Verbs that act on a place a bot names.
const PLACE_VERBS = new Set(['check', 'read', 'post', 'react', 'attach', 'set'])

/** A connector write's verdict: the place it reached, as the cloud resolved the bot's input, and
 *  for a set, the issue's state after it. */
export type ConnectorVerdict = { target: string; state?: string; refused?: true }

// As the cloud's Slack search refuses (slack-actions.ts): words only, over a whole workspace, as
// the person whose Slack message this turn answers, in their own workspace.
function searchSlackAsAsker(
  state: EvalHostState,
  ref: string,
  { text, ...filters }: NonNullable<ConnectorActionArgs['search']>
) {
  const refuse = (refusal: string, message: string) => ({ ok: false, refusal, message })
  if (!text || Object.keys(filters).length > 0) {
    return refuse('invalid_args', 'Slack search takes words only: --search <words>.')
  }
  const workspace = /^slack:([^:]+):workspace$/.exec(ref)?.[1]
  if (!workspace) {
    return refuse(
      'invalid_args',
      'Slack search covers a whole workspace: pass its ref (slack:<team>:workspace).'
    )
  }
  if (state.conversation?.source !== 'slack' || state.woken || state.conversation.noSearchGrant) {
    return refuse(
      'no_asker',
      "Slack search couldn't run as the person who asked (Slack didn't send their search permission with this message). Tell them so they can retry; results in a shared thread should come from what they can see."
    )
  }
  if (workspace !== state.bots[0]?.slack?.teamId) {
    return refuse('not_reachable', 'Search covers only the Slack workspace the person asked in.')
  }
  const { asker = OWNER_SLACK_ID, slack } = state.conversation
  return { ok: true, result: searchSlack(asker, text, slack) }
}

/** connector.act's answer, as the host passes on the cloud's. */
function act(state: EvalHostState, params: Record<string, unknown>, io: StandInIo): unknown {
  const verb = String(params.verb)
  const ref = typeof params.ref === 'string' ? params.ref : ''
  // The host's own check, before anything reaches the cloud.
  const parsed = ConnectorActionArgs.safeParse(params.args ?? {})
  if (!parsed.success) {
    throw new RuntimeClientError('invalid_argument', parsed.error.message)
  }
  const args = parsed.data
  const place = PLACE_VERBS.has(verb) ? resolvePlace(state, ref) : null
  if (place && 'ok' in place) {
    return place
  }
  // A Slack workspace holds no messages to act on (slack-actions.ts reached()).
  if (place && /^slack:[^:]+:workspace$/.test(place.ref)) {
    return { ok: false, refusal: 'invalid_ref', message: 'That ref names no Slack channel.' }
  }
  const waking = serveWakingThread(state, verb, place?.ref, params, io)
  if (waking !== undefined) {
    return waking
  }
  // A post with a title makes a new issue there, at once, where the source can.
  if (verb === 'post' && place && args.title) {
    return createIssue(state, place, args, io, params)
  }
  // Without one, a Linear post comments on an issue; a team or workspace is none.
  if (
    (verb === 'post' || verb === 'attach') &&
    place &&
    /^linear:[^:]+:(team:|workspace$)/.test(place.ref)
  ) {
    return {
      ok: false,
      refusal: 'not_found',
      message: "The bot can't see that issue in Linear, or it doesn't exist."
    }
  }
  switch (verb) {
    case 'capabilities':
      return { ok: true, result: { sources: capabilities(state) } }
    case 'places':
      return { ok: true, result: { workspaces: workspaces(state) } }
    case 'find': {
      const { search, limit } = args
      const people = state.bots[0]?.slack ? findSlackPerson(ref) : null
      // A search by name runs where the name points, once it points at one place.
      const named = search && !people && !/^\w+:/.test(ref) ? resolvePlace(state, ref) : null
      if (named && 'ok' in named) {
        return named
      }
      const where = named?.ref ?? ref
      // Slack checks a search first, as the cloud does; a person is no workspace to search.
      if (search && (people || where.startsWith('slack:'))) {
        return searchSlackAsAsker(state, where, search)
      }
      if (people) {
        return { ok: true, result: { matches: people } }
      }
      if (!search) {
        return { ok: true, result: { matches: placeMatches(state, ref) } }
      }
      return hasLinear(state) ? searchLinear(ref, search, limit, state.linearRun) : NO_LINEAR
    }
    case 'check':
      return {
        ok: true,
        result: {
          target: place,
          access: { member: true, canRead: true, canPost: true }
        }
      }
    case 'read': {
      const issue = hasLinear(state) ? linearIssue(ref, state.linearRun) : undefined
      if (args.download) {
        return downloadFile(state, ref, args.download)
      }
      return {
        ok: true,
        result: issue
          ? readLinearIssue(issue, state.linearRun)
          : { target: place, messages: place ? messagesAt(state, place) : [] }
      }
    }
    case 'set':
      return setIssue(state, ref, args, io, params)
    case 'edit':
    case 'delete':
      return change(state, verb, params, io)
    case 'post':
    case 'react':
    case 'attach':
      if (verb === 'attach' && place && isStaging(params)) {
        return STAGED(place.ref, place.label)
      }
      // As Slack refuses a bot's app in a channel it isn't in (slack-action-refusals.ts).
      if (verb === 'post' && state.notInChannels?.some((channel) => ref.includes(`:${channel}`))) {
        const result = { target: ref, refused: true as const }
        io.record({ kind: 'write', method: 'connector.post', params, result })
        return {
          ok: false,
          refusal: 'not_found',
          message:
            "The bot can't see this channel: it is private and the bot isn't in it, or it doesn't exist."
        }
      }
      io.record({
        kind: 'write',
        method: `connector.${verb}`,
        params,
        result: { target: place?.ref }
      })
      return { ok: true, result: { target: place } }
  }
  return { ok: false, refusal: 'invalid_argument', message: `No connector verb ${verb}.` }
}

function hooks(state: EvalHostState): WebhookSummary[] {
  return state.automations.flatMap((automation) => {
    const rule = automationWebhookTrigger(automation)
    const hookId = rule ? hookIdOfRule(rule.id) : null
    return hookId && automation.bot
      ? [
          {
            hookId,
            botId: automation.bot.botId,
            automationId: automation.id,
            state: 'live' as const,
            url: `https://hooks.example.invalid/w/${hookId}`,
            adapter: null,
            lastCall: null,
            host: 'online' as const,
            automationName: automation.name,
            resultsTo: automation.bot.resultsTo,
            filters: {},
            pendingCalls: 0,
            keyGeneration: 1,
            previousKeyExpiresAt: null
          }
        ]
      : []
  })
}

/** The answer to a connector or webhook method; undefined for any other. */
export function serveConnector(
  state: EvalHostState,
  method: string,
  params: Record<string, unknown>,
  io: StandInIo
): unknown {
  switch (method) {
    case 'connector.act':
      return act(state, params, io)
    case 'webhooks.list':
      return { hooks: hooks(state) }
    case 'webhooks.card':
      return hooks(state).find((entry) => entry.hookId === params.hookId)
    case 'webhooks.calls':
      return { calls: [] }
  }
  return undefined
}
