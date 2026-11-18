// Composio's trigger events for the owner's bots. A Composio project sends every event to one
// address, so Orca keeps one "Composio events" hook per project (composio-events-ingress.ts) and
// hands each call to the bot it's for. Only the owner's Set it up or by-hand choice makes that hook,
// and Set it up points the project at it; the upkeep pass keeps it working and removes what deleted
// bots and automations left.
// Every change to the project's events, and every key change, runs in one lane, so setup, upkeep
// and turning off never act on each other's stale reads; each is bound to the key it started with.
import { composioUserOfBot, type ComposioEventsPlace } from '../../shared/composio/composio-apps'
import type { Automation } from '../../shared/automations/automation-definition'
import type { ComposioApi } from './composio-api'
import { stopComposioEvents } from './composio-api-events'
import type { ComposioBots } from './composio-bots'
import {
  ComposioIngressStore,
  composioTriggersOfRule,
  composioUserOfRule,
  type ComposioIngress,
  type ComposioSavedIngress
} from './composio-events-ingress'

/**
 * - `none`: the project sends its events nowhere yet, or to Orca's hook before its secret is on it.
 * - `ours`: they already come to Orca's Composio events hook, signed.
 * - `other`: they go somewhere else, which setting this up replaces.
 */
export type ComposioEventsTarget = 'none' | 'ours' | 'other'
export type ComposioEventsStatus = {
  target: ComposioEventsTarget
  on: boolean
  /** The project's events hook, the address the by-hand steps paste; unsigned until a setup ends. */
  ingress?: { hookId: string; signed: boolean }
}

export type ComposioEventsHost = {
  /** The bot that owns the hook, or null. */
  botOf: (hookId: string) => string | null
  /** The hook's address without its key, for telling ours from another's. */
  base: (hookId: string) => Promise<string>
  /** The hook's full address, key included. */
  url: (hookId: string) => Promise<string>
  /** Saves Composio's Standard Webhooks secret on the hook. */
  setSecret: (hookId: string, secret: string) => Promise<void>
  /** Makes the project's "Composio events" automation, under the bot, and returns its hook. */
  createIngress: (botId: string) => Promise<ComposioIngress>
  automations: () => readonly Automation[]
  deleteAutomation: (id: string) => Promise<void>
}

/** `<base>/hooks/<hook id>/<key>`: the hook id, when the address is one of Orca's hooks. */
function hookIdOf(url: string): string | null {
  const parts = url.split('/')
  return parts.at(-3) === 'hooks' ? (parts.at(-2) ?? null) : null
}

export class ComposioEvents {
  private lane: Promise<unknown> = Promise.resolve()
  private place: ComposioEventsPlace | null = null

  constructor(
    private readonly composio: Pick<ComposioBots, 'withKey' | 'keyState' | 'project'>,
    private readonly host: ComposioEventsHost,
    private readonly store = new ComposioIngressStore()
  ) {}

  /** Runs `work` alone in the lane; key changes run here too. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lane.then(work, work)
    this.lane = run.catch(() => undefined)
    return run
  }

  /** Where the saved key's project sends its events, from the last upkeep; null before one ran. */
  eventsPlace(): ComposioEventsPlace | null {
    return this.place?.project === this.composio.project() ? this.place : null
  }

  /** A regenerated key reached `from`'s project: its hook is `to`'s. */
  rekeyed(from: string, to: string): void {
    this.store.relabel(from, to)
  }

  /** Runs with the key saved now, and its project for every read and write. */
  private withProject<T>(work: (api: ComposioApi, project: string) => Promise<T>): Promise<T> {
    const project = this.composio.project()
    if (!project) {
      return Promise.reject(new Error('Add your Composio key first.'))
    }
    return this.composio.withKey((api) => work(api, project))
  }

  private ownHook(botId: string, hookId: string): void {
    if (this.host.botOf(hookId) !== botId) {
      throw new Error('That webhook belongs to another bot, or no longer exists.')
    }
  }

  /**
   * The project's saved ingress, while its automation still exists. The project's events still
   * going to a hook saved under another key's name show that key reached this project (it was
   * regenerated), so that record is this project's.
   */
  private liveIngress(project: string, current?: { url: string }): ComposioSavedIngress | null {
    const hookId = current ? hookIdOf(current.url) : null
    const earlier = hookId ? this.store.projectOfHook(hookId) : null
    if (!this.store.read(project) && earlier && earlier !== project) {
      this.store.relabel(earlier, project)
    }
    const ingress = this.store.read(project)
    return ingress && this.host.automations().some((entry) => entry.id === ingress.automationId)
      ? ingress
      : null
  }

  /** Saved under the operation's project; a key changed meanwhile abandons the operation. */
  private save(project: string, ingress: ComposioSavedIngress | null): void {
    if (this.composio.project() !== project) {
      throw new Error('The Composio key changed while this ran. Try again.')
    }
    this.store.write(project, ingress)
  }

  private listening(): Automation[] {
    return this.host.automations().filter((entry) => composioUserOfRule(entry))
  }

  private async pointsAt(ingress: ComposioIngress | null, url: string | undefined) {
    // Compared without the key, so the hook after a key rotation still counts as ours.
    return Boolean(url && ingress && url.startsWith(`${await this.host.base(ingress.hookId)}/`))
  }

  async status(botId: string, hookId: string, trigger: string): Promise<ComposioEventsStatus> {
    this.ownHook(botId, hookId)
    return this.withProject(async (api, project) => {
      const [subscriptions, on] = await Promise.all([
        api.webhookSubscriptions(),
        api.triggerOn(composioUserOfBot(botId), trigger)
      ])
      const current = subscriptions[0]
      const live = this.liveIngress(project, current)
      const target: ComposioEventsTarget = !current
        ? 'none'
        : (await this.pointsAt(live, current.url))
          ? live?.signed
            ? 'ours'
            : 'none'
          : 'other'
      return {
        target,
        on,
        ...(live ? { ingress: { hookId: live.hookId, signed: live.signed } } : {})
      }
    })
  }

  /** The owner's "I'll do it in Composio": the project's events hook, made as Set it up makes it. */
  byHand(botId: string, hookId: string): Promise<string> {
    this.ownHook(botId, hookId)
    return this.exclusive(() =>
      this.withProject(async (api, project) => {
        const current = (await api.webhookSubscriptions())[0]
        const live = this.liveIngress(project, current) ?? (await this.makeIngress(project, botId))
        return live.hookId
      })
    )
  }

  /**
   * The by-hand steps' Done, for the events hook the steps showed: the project must already send
   * its events there. Turns the bot's trigger on and saves Composio's own secret on the hook, so
   * Orca checks what Composio signs with whatever upkeep or an earlier paste left there.
   */
  finishByHand(
    botId: string,
    hookId: string,
    trigger: string,
    config: Record<string, unknown>,
    shownHookId: string
  ): Promise<void> {
    this.ownHook(botId, hookId)
    return this.exclusive(() =>
      this.withProject(async (api, project) => {
        const current = (await api.webhookSubscriptions())[0]
        const live = this.liveIngress(project, current)
        if (live?.hookId !== shownHookId) {
          throw new Error(
            'Your Composio key changed since these steps were shown. Choose Change, then start again.'
          )
        }
        if (!current || !(await this.pointsAt(live, current.url))) {
          throw new Error(
            'Composio doesn’t send its events to Orca yet. Paste the URL into your project’s Webhooks in Composio, then choose Done.'
          )
        }
        await api.turnOnTrigger(composioUserOfBot(botId), trigger, config)
        await this.sign(api, project, live, current.id, null)
      })
    )
  }

  /** The owner's Set it up: the bot's trigger on, and the project pointed at Orca's events hook,
   *  signed, if it isn't yet; `replace` is their yes to taking the events from another address. */
  setUp(
    botId: string,
    hookId: string,
    trigger: string,
    config: Record<string, unknown>,
    replace: boolean
  ): Promise<void> {
    this.ownHook(botId, hookId)
    return this.exclusive(() =>
      this.withProject(async (api, project) => {
        const current = (await api.webhookSubscriptions())[0]
        const pointing = await this.pointsAt(this.liveIngress(project, current), current?.url)
        if (current && !pointing && !replace) {
          throw new Error(
            'Your Composio project already sends its events to another address. Choose Replace to send them here.'
          )
        }
        // First, as it fails on an app the bot never connected, before the project's address moves.
        await api.turnOnTrigger(composioUserOfBot(botId), trigger, config)
        const live = this.liveIngress(project)
        if (pointing && live && current) {
          // An earlier setup moved the address but its secret never reached the hook.
          if (!live.signed) {
            await this.sign(api, project, live, current.id, null)
          }
          return
        }
        const ingress = live ?? (await this.makeIngress(project, botId))
        await this.pointAt(api, project, ingress, current?.id)
      })
    )
  }

  private async makeIngress(project: string, botId: string): Promise<ComposioSavedIngress> {
    const ingress: ComposioSavedIngress = {
      ...(await this.host.createIngress(botId)),
      signed: false
    }
    this.save(project, ingress)
    return ingress
  }

  private async pointAt(
    api: ComposioApi,
    project: string,
    ingress: ComposioSavedIngress,
    replacing?: string
  ) {
    // Unsigned until the new secret is on the hook, so a failure here is finished on the next try.
    this.save(project, { ...ingress, signed: false })
    const subscription = await api.sendEventsTo(await this.host.url(ingress.hookId), replacing)
    await this.sign(api, project, ingress, subscription.id, subscription.secret)
  }

  private async sign(
    api: ComposioApi,
    project: string,
    ingress: ComposioIngress,
    subscriptionId: string,
    secret: string | null
  ): Promise<void> {
    const value = secret ?? (await api.rotateSecret(subscriptionId))
    if (!value) {
      throw new Error('Composio didn’t give a signing secret. Try again in a moment.')
    }
    // Checked before the hook takes the secret, so a key changed meanwhile can't overwrite it.
    this.save(project, { ...ingress, signed: false })
    await this.host.setSecret(ingress.hookId, value)
    this.save(project, { ...ingress, signed: true })
  }

  /**
   * Upkeep: deletes the triggers no automation of the bot's still listens for, and keeps the hook
   * the owner set up working: signed, made again under another bot when its bot went, or stopped
   * and removed when no bot listens any more. It never makes the first one.
   */
  reconcile(botIds: readonly string[]): Promise<void> {
    if (this.composio.keyState() !== 'ok') {
      return Promise.resolve()
    }
    return this.exclusive(() =>
      this.withProject(async (api, project) => {
        for (const botId of botIds) {
          await this.dropUnheardTriggers(api, botId)
        }
        await this.keepIngress(api, project)
      })
    )
  }

  private async dropUnheardTriggers(api: ComposioApi, botId: string): Promise<void> {
    const user = composioUserOfBot(botId)
    const triggers = await api.triggers(user)
    // Read after the list, so a listener made meanwhile keeps its trigger.
    const slugs = this.listening()
      .filter((entry) => composioUserOfRule(entry) === user)
      .map(composioTriggersOfRule)
    // An automation without a trigger filter takes every trigger the bot has.
    if (slugs.some((entry) => entry === null)) {
      return
    }
    const wanted = new Set(slugs.flatMap((entry) => entry ?? []))
    for (const trigger of triggers) {
      if (!wanted.has(trigger.trigger)) {
        await api.deleteTrigger(trigger.id)
      }
    }
  }

  private async keepIngress(api: ComposioApi, project: string): Promise<void> {
    const current = (await api.webhookSubscriptions())[0]
    const live = this.liveIngress(project, current)
    const saved = this.store.read(project)
    if (!saved) {
      this.place = null
      return
    }
    const toSaved = Boolean(current && hookIdOf(current.url) === saved.hookId)
    const listening = this.listening()
    const elsewhere = listening.length > 0 && Boolean(current) && !toSaved
    this.place = { project, here: toSaved, elsewhere }
    if (listening.length === 0) {
      if (toSaved) {
        await this.stopIfStillOurs(api, saved)
      }
      if (live) {
        await this.host.deleteAutomation(live.automationId)
      }
      this.save(project, null)
      return
    }
    // Another address took the project's events since: that's the owner's or another host's.
    if (current && !toSaved) {
      return
    }
    const holder = listening[0]?.bot?.botId
    if (!live && holder) {
      // The hook went with its bot: a new one under a bot still listening takes the events.
      await this.pointAt(api, project, await this.makeIngress(project, holder), current?.id)
    } else if (live && current && !live.signed) {
      await this.sign(api, project, live, current.id, null)
    }
  }

  /** Stops the project's events only if they still come to `ingress`, read just before. */
  private async stopIfStillOurs(api: ComposioApi, ingress: ComposioIngress): Promise<void> {
    const current = (await api.webhookSubscriptions())[0]
    if (current && hookIdOf(current.url) === ingress.hookId) {
      await stopComposioEvents(api, current.id)
    }
  }

  /** The Remove-key choice, run in the lane before the key goes: every bot's triggers off, and the
   *  project's events stopped. */
  turnOffNow(botIds: readonly string[]): Promise<void> {
    return this.withProject(async (api, project) => {
      for (const botId of botIds) {
        for (const trigger of await api.triggers(composioUserOfBot(botId))) {
          await api.deleteTrigger(trigger.id)
        }
      }
      const current = (await api.webhookSubscriptions())[0]
      const live = this.liveIngress(project, current)
      const saved = this.store.read(project)
      if (saved) {
        await this.stopIfStillOurs(api, saved)
      }
      if (live) {
        await this.host.deleteAutomation(live.automationId)
      }
      this.save(project, null)
    })
  }

  turnOff(botIds: readonly string[]): Promise<void> {
    return this.exclusive(() => this.turnOffNow(botIds))
  }
}
