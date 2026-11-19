// One Orca address per Composio project: the "Composio events" hook. Composio sends every bot's
// events there, and the host hands each call to the bot automation it's for, by the Composio user it
// names (orca-bot-<id>) and that automation's own filter. Adding a bot never takes another's events.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { matchesWebhookCall } from '../../../cloud/packages/connector-contract/src/webhook-matcher'
import { automationWebhookTrigger } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { WebhookWhere } from '../../shared/connector-webhook-contract'
import { EXPIRED_EVENT } from './composio-api-answers'
import { composioKeyEnvelopeFile } from './composio-key-store'

export const COMPOSIO_USER_PATH = 'body.metadata.user_id'

export type ComposioIngress = { automationId: string; hookId: string }
const Saved = z.object({
  automationId: z.string().min(1),
  hookId: z.string().min(1),
  /** The project's signing secret is on the hook; until then its calls are refused. */
  signed: z.boolean()
})
export type ComposioSavedIngress = z.infer<typeof Saved>
/** Each project's own hook, by the project's key fingerprint; the owner's setup made each one. */
const SavedFile = z.object({ projects: z.record(z.string(), Saved) })

/** Where each project's ingress is saved, next to the key on the host that runs the bots. */
export class ComposioIngressStore {
  constructor(
    private readonly file = join(dirname(composioKeyEnvelopeFile().path), 'composio-events.json')
  ) {}

  all(): Record<string, ComposioSavedIngress> {
    if (!existsSync(this.file)) {
      return {}
    }
    try {
      return SavedFile.parse(JSON.parse(readFileSync(this.file, 'utf8'))).projects
    } catch {
      return {}
    }
  }

  read(project: string | null): ComposioSavedIngress | null {
    return project ? (this.all()[project] ?? null) : null
  }

  /** The project's ingress whose hook this is, so an older project's calls are still recognised. */
  byHook(hookId: string): ComposioSavedIngress | null {
    return Object.values(this.all()).find((entry) => entry.hookId === hookId) ?? null
  }

  /** The project whose saved hook this is. */
  projectOfHook(hookId: string): string | null {
    return Object.entries(this.all()).find(([, entry]) => entry.hookId === hookId)?.[0] ?? null
  }

  /** `from`'s record becomes `to`'s, unless `to` has its own. */
  relabel(from: string, to: string): void {
    const { [from]: moved, ...others } = this.all()
    if (moved && from !== to && !others[to]) {
      this.save({ ...others, [to]: moved })
    }
  }

  write(project: string, ingress: ComposioSavedIngress | null): void {
    const { [project]: _old, ...others } = this.all()
    this.save(ingress ? { ...others, [project]: ingress } : others)
  }

  private save(projects: Record<string, ComposioSavedIngress>): void {
    if (Object.keys(projects).length === 0) {
      rmSync(this.file, { force: true })
      return
    }
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify({ projects })}\n`, { mode: 0o600 })
  }
}

/** The Composio user a bot automation's filter keeps it to, if any. */
export function composioUserOfRule(automation: Automation): string | null {
  const clause = (automationWebhookTrigger(automation)?.where ?? []).find(
    (entry: WebhookWhere) => entry.path === COMPOSIO_USER_PATH && entry.op === '='
  )
  return clause?.values?.[0] ?? null
}

/** The slugs a Composio automation's filter names; null when it takes every trigger. */
export function composioTriggersOfRule(automation: Automation): string[] | null {
  const clause = (automationWebhookTrigger(automation)?.where ?? []).find(
    (entry) =>
      entry.path === 'body.metadata.trigger_slug' && (entry.op === '=' || entry.op === 'in')
  )
  return clause?.values ?? null
}

export type ComposioCallRoute =
  | { kind: 'automation'; automationId: string }
  | { kind: 'expired'; accountId: string; app: string }
  | { kind: 'none' }

/** Where one call to the ingress goes: a bot's automation, an expired sign-in, or nowhere. */
export function routeComposioCall(
  automations: readonly Automation[],
  ingress: ComposioIngress,
  call: { headers: Readonly<Record<string, string>>; body: unknown }
): ComposioCallRoute {
  const body = z
    .object({
      type: z.string().optional(),
      metadata: z.object({ user_id: z.string().optional() }).partial().optional(),
      data: z
        .object({ id: z.string().optional(), toolkit: z.object({ slug: z.string() }).optional() })
        .partial()
        .optional()
    })
    .safeParse(call.body).data
  if (body?.type === EXPIRED_EVENT) {
    const accountId = body.data?.id
    const app = body.data?.toolkit?.slug
    return accountId && app ? { kind: 'expired', accountId, app } : { kind: 'none' }
  }
  const user = body?.metadata?.user_id
  if (!user) {
    return { kind: 'none' }
  }
  const matching = automations.filter((automation) => {
    const rule = automationWebhookTrigger(automation)
    return (
      automation.id !== ingress.automationId &&
      automation.enabled !== false &&
      rule !== undefined &&
      composioUserOfRule(automation) === user &&
      matchesWebhookCall(rule, call)
    )
  })
  // One call starts one run: the bot's automation naming the trigger, then its oldest, so adding a
  // broader one never takes a specific one's events.
  const [target] = matching.toSorted(
    (a, b) =>
      Number(composioTriggersOfRule(a) === null) - Number(composioTriggersOfRule(b) === null) ||
      a.createdAt - b.createdAt
  )
  return target ? { kind: 'automation', automationId: target.id } : { kind: 'none' }
}
