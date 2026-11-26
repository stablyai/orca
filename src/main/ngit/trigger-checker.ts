// The relay checks behind bots' ngit rules. It rides the host's automation tick, reads only
// repositories an enabled rule watches, and hands each match to the shared event run path.
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import { isNgitTrigger, type AutomationNgitTrigger } from '../../shared/automation-ngit-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import { parseNostrCloneUrl, type NostrRepositoryAddress } from './nostr-repository-address'
import type { NostrRepositorySnapshot } from './repository-snapshot'
import { ngitRuleMatches, ngitRunEvent, repositoryOccurrences } from './trigger-match'
import type { NgitTriggerState } from './trigger-state'

// A repository's whole history is read each time, so public relays are asked sparingly.
export const NGIT_CHECK_INTERVAL_MS = 3 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const MAX_HANDLED = 2_000

export type NgitTriggerCheckerDeps = {
  automations(): readonly Pick<Automation, 'id' | 'enabled' | 'bot' | 'on'>[]
  read(address: NostrRepositoryAddress): Promise<NostrRepositorySnapshot | null>
  /** The npub `ngit` signs with on this host, if any. */
  ownNpub(): Promise<string | null>
  runForEvent(automationId: string, event: AutomationRunEvent): Promise<unknown>
  readState(): Promise<NgitTriggerState>
  writeState(state: NgitTriggerState): Promise<void>
  now(): number
}

type Target = {
  automationId: string
  botId: string
  repository: string
  rule: AutomationNgitTrigger
}

function ruleTargets(automations: ReturnType<NgitTriggerCheckerDeps['automations']>): Target[] {
  return automations.flatMap(({ id, enabled, bot, on }) =>
    enabled && bot
      ? (on ?? []).filter(isNgitTrigger).flatMap((rule) =>
          rule.in.map((repository) => ({
            automationId: id,
            botId: bot.botId,
            repository,
            rule
          }))
        )
      : []
  )
}

const listenerKey = (target: Target) => `${target.botId} ${target.repository}`

export class NgitTriggerChecker {
  private checking = false
  private readonly nextCheck = new Map<string, { at: number; failures: number }>()

  constructor(private readonly deps: NgitTriggerCheckerDeps) {}

  /** One check, unless the last is still running. */
  async tick(): Promise<void> {
    if (this.checking) {
      return
    }
    this.checking = true
    try {
      await this.check()
    } catch (error) {
      console.warn('[ngit] trigger check failed', error)
    } finally {
      this.checking = false
    }
  }

  private async check(): Promise<void> {
    const targets = ruleTargets(this.deps.automations())
    const state = await this.deps.readState()
    const before = JSON.stringify(state)
    const now = this.deps.now()
    // A rule listens from when it was first seen; a removed one forgets, so re-adding starts over.
    const listening = new Set(targets.map(listenerKey))
    for (const key of listening) {
      state.listeners[key] ??= now
    }
    for (const key of Object.keys(state.listeners)) {
      if (!listening.has(key)) {
        delete state.listeners[key]
      }
    }
    for (const repository of new Set(targets.map((target) => target.repository))) {
      const schedule = this.nextCheck.get(repository)
      if (schedule && now < schedule.at) {
        continue
      }
      try {
        await this.checkRepository(
          repository,
          targets.filter((target) => target.repository === repository),
          state,
          now
        )
        this.nextCheck.set(repository, { at: now + NGIT_CHECK_INTERVAL_MS, failures: 0 })
      } catch (error) {
        const failures = (schedule?.failures ?? 0) + 1
        this.nextCheck.set(repository, {
          failures,
          at: now + Math.min(NGIT_CHECK_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
        })
        if (failures === 1) {
          console.warn(`[ngit] check of ${repository} failed; backing off`, error)
        }
      }
    }
    state.handled = state.handled.slice(-MAX_HANDLED)
    if (JSON.stringify(state) !== before) {
      await this.deps.writeState(state)
    }
  }

  private async checkRepository(
    repository: string,
    targets: Target[],
    state: NgitTriggerState,
    now: number
  ): Promise<void> {
    const address = parseNostrCloneUrl(repository)
    const snapshot = address ? await this.deps.read(address) : null
    if (!snapshot) {
      throw new Error('Repository not found on its relays.')
    }
    const occurrences = repositoryOccurrences(snapshot).toSorted(
      (a, b) => a.event.created_at - b.event.created_at
    )
    const handled = new Set(state.handled)
    const ownNpub = await this.deps.ownNpub()
    for (const occurrence of occurrences) {
      for (const target of targets) {
        const since = state.listeners[listenerKey(target)] ?? now
        const id = `${target.automationId} ngit:${occurrence.event.id}`
        // Nostr times are whole seconds.
        if (
          handled.has(id) ||
          occurrence.event.created_at < Math.floor(since / 1000) ||
          !ngitRuleMatches(target.rule, occurrence, snapshot.repository.maintainers, ownNpub)
        ) {
          continue
        }
        try {
          await this.deps.runForEvent(
            target.automationId,
            ngitRunEvent(target.rule, occurrence, snapshot.repository.name)
          )
          handled.add(id)
          state.handled.push(id)
        } catch (error) {
          // Left unhandled, so the next check offers it again; the run path drops repeats.
          console.warn('[ngit] could not start an automation run', error)
        }
      }
    }
  }
}
