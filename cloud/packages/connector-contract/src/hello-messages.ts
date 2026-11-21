import { OpaqueIdSchema, SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { readHelloTriggers } from './trigger-messages.js'
import { WebhookHookIdSchema } from './webhook-messages.js'
import { webhookRuleId } from './webhook-names.js'
import { CONNECTOR_SOURCES, ConnectorHostDescription } from './connector-wire-scalars.js'

export const CONNECTOR_PROMPT_KINDS = ['approval', 'question'] as const
// trigger: takes trigger deliveries, which start its bot automations. webhook: also those of its hooks'
// calls, and it fetches each call and asks to start its run. triggerInTurn: a bot's start or send may
// carry the automations its message also matches, which run in that turn. prEvents: takes pr_event
// deliveries for pull requests its bots' owner opened. threadCatchUp: a start or send's context may
// carry 'bot' and 'more' items. batchedSends: a conversation's sends queued behind its start or
// send may come in the same poll, and the machine runs them with it as one turn. ownDmChats: a bot
// start for a DM that ran in the bot's Chat opens the DM a chat of its own. askerNote: Orca's lines on
// where a bot was asked come as asker.note, apart from the asker's words.
export const CONNECTOR_FEATURES = [
  'answer',
  'cancel',
  'reply',
  'turnCancel',
  'trigger',
  'webhook',
  'triggerInTurn',
  'prEvents',
  'threadCatchUp',
  'batchedSends',
  'ownDmChats',
  'askerNote'
] as const

// The cloud uses only what a machine lists; an entry it does not know is ignored, not refused.
const CapabilityList = z.array(z.string().min(1))

// Display strings are capped so a hello's size is predictable; the machine shortens longer ones.
const DisplayText = z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength)

// A workspace of a source with one shared app for every bot (Linear, GitHub) where the owner turned
// the bot on, and the people there (that source's user ids) the owner lets ask it.
export const ConnectorBotWorkspaceSchema = z
  .object({
    source: z.enum(CONNECTOR_SOURCES),
    workspaceId: z.string().min(1).max(CONNECTOR_LIMITS.maxBotIdLength),
    members: z
      .array(z.string().min(1).max(CONNECTOR_LIMITS.maxBotWorkspaceMemberIdLength))
      .max(CONNECTOR_LIMITS.maxBotMembers)
  })
  // A Slack row splits the bot's Slack list by workspace, so it takes as many as that list.
  .refine(
    (workspace) =>
      workspace.source === 'slack' ||
      workspace.members.length <= CONNECTOR_LIMITS.maxBotWorkspaceMembers
  )

const isSlackRow = (workspace: { source: string }) => workspace.source === 'slack'

// A string source this cloud doesn't list (a newer machine's).
const isUnknownSource = (entry: unknown) =>
  typeof entry === 'object' &&
  entry !== null &&
  'source' in entry &&
  typeof entry.source === 'string' &&
  !CONNECTOR_SOURCES.some((known) => known === entry.source)

// A workspace of a source this cloud doesn't know yet is dropped, not refused, so a newer machine's
// hello still lands.
const BotWorkspacesSchema = z.preprocess(
  (entries) =>
    Array.isArray(entries) ? entries.filter((entry: unknown) => !isUnknownSource(entry)) : entries,
  z
    .array(ConnectorBotWorkspaceSchema)
    .max(CONNECTOR_LIMITS.maxBotWorkspaces + CONNECTOR_LIMITS.maxBotSlackWorkspaces)
    .refine((workspaces) => {
      const slack = workspaces.filter(isSlackRow)
      return (
        slack.length <= CONNECTOR_LIMITS.maxBotSlackWorkspaces &&
        workspaces.length - slack.length <= CONNECTOR_LIMITS.maxBotWorkspaces &&
        slack.reduce((count, workspace) => count + workspace.members.length, 0) <=
          CONNECTOR_LIMITS.maxBotMembers
      )
    })
    .optional()
)

// A bot this machine hosts. The id is the machine's own; the cloud keys it under the account.
export const ConnectorBotSchema = z.object({
  id: z.string().min(1).max(CONNECTOR_LIMITS.maxBotIdLength),
  name: DisplayText,
  agent: z.string().min(1),
  // The chat-service user ids the owner lets ask the bot.
  members: z.array(z.string().min(1).max(32)).max(CONNECTOR_LIMITS.maxBotMembers),
  paused: z.boolean(),
  // How people name the bot where bots share one app ("@Orca reviewer", label bot:reviewer).
  handle: z
    .string()
    .max(CONNECTOR_LIMITS.maxBotHandleLength)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  sharedAppWorkspaces: BotWorkspacesSchema
})

export const ConnectorHelloRequestSchema = z
  .object({
    v: z.literal(1),
    contract: z.number().int().positive(),
    ...ConnectorHostDescription,
    promptKinds: CapabilityList,
    features: CapabilityList,
    // The cloud sends a conversation only to a machine that lists its source.
    sources: CapabilityList,
    // Every bot this machine hosts; a machine without bots omits it, which leaves its rows alone.
    bots: z.array(ConnectorBotSchema).max(CONNECTOR_LIMITS.maxHelloBots).optional(),
    // Instead of `bots`, to a cloud listing `bots.pages`: every bot is in these staged pages. The hello
    // takes all of them or is refused with bot_pages_missing, so a partial list never replaces the bots.
    botPages: z
      .object({
        inventoryId: OpaqueIdSchema,
        pages: z.number().int().min(1).max(CONNECTOR_LIMITS.maxBotPages)
      })
      .optional(),
    // The event rules of its bot automations, from a machine that lists the trigger feature; read by
    // readHelloTriggers.
    triggers: z.array(z.unknown()).max(CONNECTOR_LIMITS.maxHelloTriggers).optional(),
    // Some rules didn't fit; an older machine omits it. See helloShowsHookRuleGone.
    triggersTruncated: z.boolean().optional()
  })
  .refine((hello) => hello.bots === undefined || hello.botPages === undefined)
  .transform(({ triggers, ...hello }) => ({ ...hello, ...readHelloTriggers(triggers) }))

// PUT botPages: page `index` of `pages` of one inventory, staged until the hello naming it.
export const ConnectorBotPageRequestSchema = z
  .object({
    v: z.literal(1),
    inventoryId: OpaqueIdSchema,
    index: z.number().int().min(0),
    pages: z.number().int().min(1).max(CONNECTOR_LIMITS.maxBotPages),
    bots: z.array(ConnectorBotSchema).min(1).max(CONNECTOR_LIMITS.maxHelloBots)
  })
  .refine((page) => page.index < page.pages)

// Every hello gets a revision above every earlier one for this machine, assigned by the cloud. Polls, acks
// and events carry it; under an older one they get 409 hello_required.
// features: what this cloud takes beyond the contract version (`review`: replies with inline review
// notes; `workers`: the `workers` event; `triggers.inThread`: a rule's run answers in its event's
// thread; `actions`: the shared verbs on the actions route; `refs`: a rule's places and subject may be
// refs, and find marks its exact matches; `triggers.people`: a rule's `from` and `onOwnerMessage`;
// `slack.teams`: a bot's own Slack app in several workspaces, with Who can ask per workspace as
// `slack` workspace rows, beside the other rows and up to maxBotMembers people, and `team` on its
// Slack calls); a machine sends those only to a cloud that
// lists them.
export const CONNECTOR_CLOUD_FEATURES = [
  'review',
  'workers',
  'triggers.inThread',
  'actions',
  'refs',
  'triggers.people',
  'slack.teams',
  // The places verb, and workspace refs (slack:T1:workspace) as a rule's place.
  'places',
  // find's `search`, on the sources whose find capability lists it.
  'find.search',
  // A machine with more bots than one hello lists sends them all in staged pages (botPages).
  'bots.pages',
  // reply's `stage` and `files`: a reply's words and several files as one post.
  'reply.files',
  // One chat owns a thread: the acts-for and unlinked events, and the chat_gone refusal.
  'threads.owner',
  // A rule's `fromOwner`: a GitHub pull request its bot's owner opened starts it, with the PR's head.
  'triggers.own',
  // GitHub's pull request states (ci_passed, pr_conflicted), pr_closed, pr_ready, labeled (and a
  // rule's `label`), issue_closed, deploy_finished and security_alert; ci_failed on a failing check.
  'triggers.github2',
  // github.workflow_finished: one GitHub Actions run, named by a rule's `run`, finished.
  'triggers.workflows',
  // Files go straight between the machine and the source: `upload` with stage hands out the source's
  // upload URL, attach takes staged `files`, and read's `stream` answers a link to the bytes.
  'files.direct'
] as const
// Hooks can be made. Listed only while webhooks are switched on and the cloud's sealing keys are valid.
export const CONNECTOR_CLOUD_WEBHOOKS_FEATURE = 'webhooks'
// The cloud reads a prompt's raisedBy and routes or masks it by it, so a bot link's prompts from turns
// its conversation didn't ask for may be sent. Kept out of CONNECTOR_CLOUD_FEATURES: only the code
// that honours raisedBy lists it, so a contract bump alone never advertises it.
export const CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE = 'prompts.audience'
// The cloud takes a turn's answer up to maxLongAnswerBytes; a machine sends one over
// maxLastAssistantMessageBytes only to a cloud that lists it.
export const CONNECTOR_CLOUD_LONG_ANSWERS_FEATURE = 'answers.long'
// The cloud takes a post's `postAt` and has the source post it then. Kept out of
// CONNECTOR_CLOUD_FEATURES: only the code that schedules lists it.
export const CONNECTOR_CLOUD_POST_SCHEDULE_FEATURE = 'post.schedule'
// The cloud takes the verbs for Slack's own surfaces (pin, canvas, list, scheduled). Kept out of
// CONNECTOR_CLOUD_FEATURES, as post.schedule is.
export const CONNECTOR_CLOUD_SLACK_TOOLS_FEATURE = 'slack.tools'
// The cloud takes the `activity` event and shows it on a working thread. Kept out of
// CONNECTOR_CLOUD_FEATURES, as prompts.audience is: only the code that reads the event lists it.
export const CONNECTOR_CLOUD_TURN_ACTIVITY_FEATURE = 'turn.activity'
// Listed by a machine that keeps a reply outbox, and by a cloud that takes its `reply` events (kept
// out of CONNECTOR_CLOUD_FEATURES: the cloud lists it only while its switch is on). Under a hello
// whose answer doesn't list it, the machine posts the same outcomes through replies instead.
export const CONNECTOR_REPLIES_OUTBOX_FEATURE = 'replies.outbox'
// The cloud shows a usage-limit pause that will resume (a turn-ended's `resumes`) as paused. Kept out
// of CONNECTOR_CLOUD_FEATURES: only the code that renders it lists it, behind its switch.
export const CONNECTOR_REPLIES_PAUSED_FEATURE = 'replies.paused'
// A machine feature: it answers a byReply prompt from an answer delivery's text.
export const CONNECTOR_ANSWER_TEXT_FEATURE = 'answer.text'
export const ConnectorHelloResponseSchema = z.object({
  helloRev: SequenceSchema,
  features: z.array(z.string()).optional(),
  // Hooks of this machine deleted while it was away, so it drops their rules, files and calls.
  webhookTombstones: z.array(WebhookHookIdSchema).optional()
})

export type ConnectorBot = z.infer<typeof ConnectorBotSchema>
export type ConnectorBotWorkspace = z.infer<typeof ConnectorBotWorkspaceSchema>
export type ConnectorHelloRequest = z.infer<typeof ConnectorHelloRequestSchema>
export type ConnectorBotPageRequest = z.infer<typeof ConnectorBotPageRequestSchema>
export type ConnectorHelloResponse = z.infer<typeof ConnectorHelloResponseSchema>

/**
 * Whether a hello, as its request was read, shows the hook's rule is gone from its machine, so the
 * hook may be orphaned or moved. Only a machine that lists webhook, sends its rules and says none was
 * cut can, and never while the rule is there but unreadable here. A stored hello has no rules.
 */
export function helloShowsHookRuleGone(hello: ConnectorHelloRequest, hookId: string): boolean {
  return (
    hello.features.includes('webhook') &&
    hello.triggersTruncated === false &&
    hello.triggers !== undefined &&
    !hello.unreadHookIds?.includes(hookId) &&
    !hello.triggers.some((rule) => rule.id === webhookRuleId(hookId))
  )
}
