import { EpochMsSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import type { BotAskers } from './bot-askers.js'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { CONNECTOR_PLACE_SOURCES } from './connector-wire-scalars.js'
import { isWorkspaceRef, parseConnectorRef } from './action-messages.js'
import { ConnectorWebhookTriggerSchema, WebhookTriggerEventSchema } from './webhook-messages.js'
import { hookIdOfActor, hookIdOfRule } from './webhook-names.js'

const Id = z.string().min(1).max(CONNECTOR_LIMITS.maxBotIdLength)
const FilterText = z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength)

// One rule of a bot automation on this machine. Anyone in a place the bot and its owner are in may
// fire it, as Who can ask gates only asking the bot; `from` narrows it to some people. Events are open
// strings, so a newer machine's kinds never fail a hello.
export const ConnectorEventTriggerSchema = z.object({
  id: Id,
  automationId: Id,
  botId: Id,
  source: z.enum(CONNECTOR_PLACE_SOURCES),
  event: z.string().min(1).max(64),
  // Places as refs (slack:T1:C1, github:<installation>:<repoId>, linear:<org>:team:<teamId>, or a whole
  // workspace: linear:<org>:workspace, sent only to a cloud listing `places`), or as a machine wrote
  // them before refs: Slack channel ids, "owner/name" repos, Linear team keys ("ENG"). Absent means
  // anywhere.
  in: z.array(Id).max(CONNECTOR_LIMITS.maxTriggerPlaces).optional(),
  textContains: FilterText.optional(),
  // github.labeled only: that label, in any case. Sent only to a cloud listing `triggers.github2`.
  label: FilterText.optional(),
  // github.workflow_finished only: the one GitHub Actions run, by its id, in the repo `in` names.
  // Sent only to a cloud listing `triggers.workflows`.
  run: z.string().regex(/^\d{1,20}$/).optional(),
  // One PR or issue, as a ref, or as written before refs: "owner/name#482", "ENG-123".
  subject: FilterText.optional(),
  // Only these people's events, by their id in the source; absent means anyone. Sent only to a
  // cloud listing `triggers.people`.
  from: z.array(Id).max(CONNECTOR_LIMITS.maxTriggerPlaces).optional(),
  // A reaction only on a message the bot's owner wrote. Sent only with `from`'s feature.
  onOwnerMessage: z.literal(true).optional(),
  // The owner's own events count too, beside anyone `from` names (with no `from`, only the owner's).
  // Only a GitHub pull request the owner opened: the bot works as its owner there, so the owner's
  // other events would start it on its own work. Sent only to a cloud listing `triggers.own`.
  fromOwner: z.literal(true).optional(),
  // The automation's missed-run grace: how long an event may wait for this machine.
  graceMinutes: z.number().int().nonnegative(),
  // Its run answers in the event's own thread, so its conversation is bound there.
  inThread: z.literal(true).optional()
})

export const ConnectorTriggerSchema = z.union([
  ConnectorEventTriggerSchema,
  ConnectorWebhookTriggerSchema
])

// An entry's id when it names a hook, whether or not this cloud can read the rest of it.
function hookRuleIdOf(entry: unknown): string | null {
  return typeof entry === 'object' &&
    entry !== null &&
    'id' in entry &&
    typeof entry.id === 'string' &&
    hookIdOfRule(entry.id) !== null
    ? entry.id
    : null
}

/**
 * A hello's triggers as this cloud reads them: an odd rule is dropped, never the hello. A hook's rule
 * that is unreadable, listed twice, or not its automation's first webhook is dropped too, and its hook
 * is in unreadHookIds: the rule is still on the machine, so the hook must not look gone.
 */
export function readHelloTriggers(entries: readonly unknown[] | undefined): {
  triggers?: ConnectorTrigger[]
  unreadHookIds?: string[]
} {
  if (!entries) {
    return {}
  }
  const read = entries.map((entry) => ({
    ruleId: hookRuleIdOf(entry),
    rule: ConnectorTriggerSchema.safeParse(entry).data
  }))
  const unread = new Set(read.flatMap(({ ruleId, rule }) => (ruleId && !rule ? [ruleId] : [])))
  const webhooks = read.flatMap(({ rule }) => (rule?.source === 'webhook' ? [rule] : []))
  const listings = new Map<string, number>()
  const firstOfAutomation = new Map<string, string>()
  for (const { id, automationId } of webhooks) {
    listings.set(id, (listings.get(id) ?? 0) + 1)
    firstOfAutomation.set(automationId, firstOfAutomation.get(automationId) ?? id)
  }
  for (const { id, automationId } of webhooks) {
    if (listings.get(id) !== 1 || firstOfAutomation.get(automationId) !== id) {
      unread.add(id)
    }
  }
  const triggers = read.flatMap(({ rule }) =>
    rule && !(rule.source === 'webhook' && unread.has(rule.id)) ? [rule] : []
  )
  const unreadHookIds = [...unread].flatMap((id) => hookIdOfRule(id) ?? [])
  return unreadHookIds.length === 0 ? { triggers } : { triggers, unreadHookIds }
}

// What happened, for the run's quoted block. The machine takes source and kind from its own rule.
export const SourceTriggerEventSchema = z.object({
  // The source's own id for the event (Slack team:channel:ts, Linear-Delivery, ...): one run per key.
  key: z.string().min(1).max(256),
  // Who did it, in the source; the machine checks it against the bot's members again. Never a hook.
  actorId: z
    .string()
    .min(1)
    .max(CONNECTOR_LIMITS.maxBotIdLength)
    .refine((id) => hookIdOfActor(id) === null),
  // The bot's owner did it; the machine doesn't know the owner's id in each source.
  fromOwner: z.literal(true).optional(),
  // A reaction on a message the owner wrote, for a rule that asks for only those.
  onOwnerMessage: z.literal(true).optional(),
  // A pull request that was opened, by its head, so the machine can tell one a bot's worker opened
  // as the owner from one the owner opened. Repos by their GitHub id.
  pr: z
    .object({
      repoId: z.string().regex(/^\d{1,32}$/),
      number: z.number().int().positive(),
      headRef: z.string().min(1).max(256),
      headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
      headRepoId: z.string().regex(/^\d{1,32}$/).optional()
    })
    .optional(),
  // The thread, PR or issue; later events on it fold into its unfinished run.
  subject: z.string().min(1).max(256).optional(),
  occurredAt: EpochMsSchema,
  actor: FilterText.optional(),
  place: FilterText.optional(),
  url: z.string().url().max(2048).optional(),
  text: z.string().max(CONNECTOR_LIMITS.maxTriggerTextLength).optional(),
  webhook: z.never().optional()
})

export const ConnectorTriggerEventSchema = z.union([
  SourceTriggerEventSchema,
  WebhookTriggerEventSchema
])

// An event as a source sees it, before it is matched against the rules. Webhook calls never come
// through here: the cloud's webhook outbox delivers each straight to its hook's rule.
export type ConnectorSourceEvent = {
  source: Exclude<ConnectorTrigger['source'], 'webhook'>
  event: string
  actorId: string
  // The channel, repo or team it happened in, and its thread, PR or issue: as a rule written before
  // refs names them, and as refs.
  in: string
  subject?: string
  inRef?: string
  subjectRef?: string
  text?: string
  // A reaction's message author.
  itemAuthorId?: string
  // The label a GitHub issue or pull request was given.
  label?: string
  // The GitHub Actions run that finished, by its id.
  run?: string
}

// The bot whose rules are matched: its own user in the source, and its owner's.
export type TriggerBot = Pick<BotAskers, 'ownerUserId'> & { botUserId: string }

/**
 * The one matcher, used by the cloud and by the machine for events it reads itself. Who did it
 * matters only as the rule's `from` says: the bot never starts itself, and each source checks that
 * the owner can see the place and skips other bots.
 */
const sameName = (a: string, b: string | undefined) => a.toLowerCase() === b?.toLowerCase()

// A ref matches by its source's stable ids; the workspace only picks a token, and a GitHub app's
// reinstall changes it while the repo stays. A workspace ref matches anywhere in its workspace. A rule
// written before refs matches its names whatever their case, as GitHub names do.
function samePlace(wanted: string, name: string | undefined, ref: string | undefined): boolean {
  const asRef = parseConnectorRef(wanted)
  if (!asRef) {
    return sameName(wanted, name)
  }
  const got = ref === undefined ? null : parseConnectorRef(ref)
  if (got !== null && isWorkspaceRef(asRef)) {
    return got.source === asRef.source && got.workspaceId === asRef.workspaceId
  }
  return (
    got !== null &&
    got.source === asRef.source &&
    got.containerId === asRef.containerId &&
    got.threadId === asRef.threadId
  )
}

// Anyone when the rule names no one; else the people `from` names, and the owner when `fromOwner`
// says so. Whether the owner's events reach a rule at all is each source's to say.
function fromPeople(
  trigger: Pick<ConnectorEventTrigger, 'from' | 'fromOwner'>,
  actorId: string,
  ownerUserId: string
): boolean {
  if (!trigger.from?.length && !trigger.fromOwner) {
    return true
  }
  return (
    (trigger.from?.includes(actorId) ?? false) ||
    (trigger.fromOwner === true && actorId === ownerUserId)
  )
}

export function matchesTrigger(
  trigger: Pick<
    ConnectorEventTrigger,
    | 'source'
    | 'event'
    | 'in'
    | 'textContains'
    | 'label'
    | 'run'
    | 'subject'
    | 'from'
    | 'onOwnerMessage'
    | 'fromOwner'
  >,
  event: ConnectorSourceEvent,
  bot: TriggerBot
): boolean {
  return (
    event.actorId !== bot.botUserId &&
    fromPeople(trigger, event.actorId, bot.ownerUserId) &&
    (!trigger.onOwnerMessage || event.itemAuthorId === bot.ownerUserId) &&
    trigger.source === event.source &&
    trigger.event === event.event &&
    (!trigger.in?.length || trigger.in.some((place) => samePlace(place, event.in, event.inRef))) &&
    (!trigger.subject || samePlace(trigger.subject, event.subject, event.subjectRef)) &&
    (!trigger.label || sameName(trigger.label, event.label)) &&
    (!trigger.run || trigger.run === event.run) &&
    (!trigger.textContains ||
      (event.text ?? '')
        .slice(0, CONNECTOR_LIMITS.maxTriggerTextLength)
        .toLowerCase()
        .includes(trigger.textContains.toLowerCase()))
  )
}

export type ConnectorTrigger = z.infer<typeof ConnectorTriggerSchema>
export type ConnectorEventTrigger = z.infer<typeof ConnectorEventTriggerSchema>
export type ConnectorTriggerEvent = z.infer<typeof ConnectorTriggerEventSchema>
export type ConnectorSourceTriggerEvent = z.infer<typeof SourceTriggerEventSchema>
