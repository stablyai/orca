// Once this host's Orca Cloud takes refs, the places bot automations named before them become refs.
// Idempotent: a ref is left alone, and a name the cloud can't place stays as it was, still matched
// by name, for the next pass to try again.
import type {
  Automation,
  AutomationUpdateInput
} from '../../shared/automations/automation-definition'
import {
  isConnectorTrigger,
  withTriggerNames,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import { isRefOf } from '../../shared/connector-place-names'
import type {
  ConnectorRefResolver,
  ConnectorRefRole
} from '../connector-cloud/connector-ref-resolution'
import { resolvedResultPlace, sameBotPlaces, shownName } from './bot-automation-place-refs'

type Row = Pick<Automation, 'id' | 'on' | 'bot'>

export type BotPlaceMigrationHost = {
  list(): Row[]
  /** Writes only while the automation's rules and bot target are still `unchangedSince`. */
  update(
    id: string,
    patch: Pick<AutomationUpdateInput, 'on' | 'bot'>,
    unchangedSince: Pick<Automation, 'on' | 'bot'>
  ): Promise<unknown>
}

/** Rewrites each bot automation that still names a place by name; returns how many it rewrote. */
export async function migrateBotAutomationPlaces(
  host: BotPlaceMigrationHost,
  resolve: ConnectorRefResolver
): Promise<number> {
  let rewritten = 0
  for (const automation of host.list()) {
    const bot = automation.bot
    if (!bot) {
      continue
    }
    const asRef = async (source: string, role: ConnectorRefRole, value: string) =>
      isRefOf(source, value)
        ? { ref: value }
        : await resolve(bot.botId, source, role, value).catch(() => null)
    let changed = false
    const on = await Promise.all(
      (automation.on ?? []).map(async (rule): Promise<AutomationEventTrigger> => {
        if (!isConnectorTrigger(rule)) {
          return rule
        }
        const names: Record<string, string> = { ...rule.names }
        const placed = async (role: ConnectorRefRole, value: string) => {
          const found = (await asRef(rule.source, role, value)) ?? { ref: value }
          if (shownName(rule.source, found)) {
            names[found.ref] = found.label
          }
          return found.ref
        }
        const places =
          rule.in &&
          [...new Set(await Promise.all(rule.in.map((value) => placed('place', value))))].sort()
        const subject = rule.subject && (await placed('subject', rule.subject))
        const next = withTriggerNames(
          { ...rule, ...(places ? { in: places } : {}), ...(subject ? { subject } : {}) },
          names
        )
        changed ||= JSON.stringify(next) !== JSON.stringify(rule)
        return next
      })
    )
    let resultsTo = bot.resultsTo
    if (typeof resultsTo === 'object' && !resultsTo.ref) {
      const found = await resolvedResultPlace(resolve, bot.botId, resultsTo).catch(() => null)
      if (found) {
        resultsTo = found
        changed = true
      }
    }
    if (!changed) {
      continue
    }
    // Looked up while this pass waited on the cloud: an edit since then wins, and the next launch retries.
    const now = host.list().find((entry) => entry.id === automation.id)
    if (!now || !sameBotPlaces(now, automation)) {
      continue
    }
    try {
      await host.update(
        automation.id,
        {
          ...(automation.on ? { on } : {}),
          ...(resultsTo === bot.resultsTo ? {} : { bot: { ...bot, resultsTo } })
        },
        { on: automation.on, bot }
      )
      rewritten += 1
    } catch (error) {
      console.warn('[automations] could not rewrite places as refs', automation.id, error)
    }
  }
  return rewritten
}

/** The pass once per launch, on the first hello whose cloud takes refs; a later launch tries again. */
export function botPlaceMigrationOnHello(
  host: BotPlaceMigrationHost,
  resolver: () => ConnectorRefResolver | null
): () => void {
  let started = false
  return () => {
    const resolve = resolver()
    if (started || !resolve) {
      return
    }
    started = true
    void migrateBotAutomationPlaces(host, resolve).catch((error) =>
      console.warn('[automations] the refs pass failed', error)
    )
  }
}
