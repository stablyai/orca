import type { TeamUpdateRestart } from '../../../shared/updater/update-status-types'
import {
  TeamUpdateRestartRecordStore,
  type TeamUpdateRestartRecord,
  type TeamUpdateRestartScope
} from './team-update-restart-record'

const HOUR_MS = 60 * 60 * 1000
const SNOOZE_MS = 4 * HOUR_MS
const COUNTDOWN_MS = 10 * 60 * 1000
const AGENT_DEFERRAL_MS = 2 * HOUR_MS
const AGENT_RECHECK_MS = 30_000
const MAX_ATTEMPTS = 2

type VerifiedUpdate = {
  generation: number
  scope: TeamUpdateRestartScope
  store: TeamUpdateRestartRecordStore
  record: TeamUpdateRestartRecord
}

type RestartPorts = {
  scope: () => TeamUpdateRestartScope | undefined
  deadlineHours: (version: string) => number | undefined
  hasWorkingAgents: () => boolean
  publish: (version: string, state: TeamUpdateRestart) => void
  install: () => void
}

export class TeamUpdateRestartController {
  private current: VerifiedUpdate | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private attempted = new Set<string>()
  private generation = 0

  constructor(private readonly ports: RestartPorts) {}

  async verified(version: string, runningVersion: string): Promise<void> {
    const scope = this.ports.scope()
    if (!scope) {
      return
    }
    const generation = ++this.generation
    const downloadedAt = Date.now()
    const existing = this.current
    clearTimeout(this.timer)
    const store =
      existing?.scope.file === scope.file
        ? existing.store
        : new TeamUpdateRestartRecordStore(scope.file)
    const saved = existing?.scope.file === scope.file ? existing.record : await store.read()
    if (generation !== this.generation) {
      return
    }
    const record =
      saved?.accountId === scope.accountId &&
      saved.runningVersion === runningVersion &&
      saved.version === version &&
      saved.downloadedAt <= downloadedAt
        ? saved
        : { accountId: scope.accountId, runningVersion, version, downloadedAt, installAttempts: 0 }
    const update = { generation, scope, store, record }
    this.current = update
    await store.write(record)
    await this.refresh(update)
  }

  cancel(): void {
    this.generation++
    clearTimeout(this.timer)
  }

  async snooze(): Promise<void> {
    const update = this.current
    if (!update) {
      return
    }
    const deadlineAt = this.deadline(update)
    const now = Date.now()
    if (
      deadlineAt === undefined ||
      now >= deadlineAt ||
      update.record.installAttempts >= MAX_ATTEMPTS ||
      this.attempted.has(this.attemptKey(update))
    ) {
      return
    }
    update.record.snoozedUntil = Math.min(now + SNOOZE_MS, deadlineAt)
    clearTimeout(this.timer)
    await update.store.write(update.record)
    await this.refresh(update)
  }

  async recordAttempt(version: string, automatic: boolean): Promise<boolean> {
    const update = this.current
    if (!update || update.record.version !== version || this.deadline(update) === undefined) {
      return !automatic
    }
    const key = this.attemptKey(update)
    if (automatic && (update.record.installAttempts >= MAX_ATTEMPTS || this.attempted.has(key))) {
      return false
    }
    this.attempted.add(key)
    clearTimeout(this.timer)
    if (update.record.installAttempts < MAX_ATTEMPTS) {
      update.record.installAttempts++
      await update.store.write(update.record)
    }
    return !automatic || this.deadline(update) !== undefined
  }

  exhausted(version: string): boolean {
    return (
      this.current?.record.version === version &&
      this.current.record.installAttempts >= MAX_ATTEMPTS
    )
  }

  private attemptKey({ scope, record }: VerifiedUpdate): string {
    return JSON.stringify([scope.file, scope.accountId, record.runningVersion, record.version])
  }

  private deadline(update: VerifiedUpdate): number | undefined {
    const liveScope = this.ports.scope()
    if (
      update.generation !== this.generation ||
      this.current !== update ||
      liveScope?.file !== update.scope.file ||
      liveScope.accountId !== update.scope.accountId
    ) {
      return undefined
    }
    const hours = this.ports.deadlineHours(update.record.version)
    return hours === undefined ? undefined : update.record.downloadedAt + hours * HOUR_MS
  }

  private wakeAt(update: VerifiedUpdate, when: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(
      () => {
        void this.refresh(update).catch((error) =>
          console.warn('[updater] Team restart state:', error)
        )
      },
      Math.max(0, when - Date.now())
    )
    this.timer.unref?.()
  }

  private async refresh(update: VerifiedUpdate): Promise<void> {
    const deadlineAt = this.deadline(update)
    if (deadlineAt === undefined) {
      return
    }
    const { record } = update
    const publish = (phase: Exclude<TeamUpdateRestart['phase'], 'countdown'>): void => {
      this.ports.publish(record.version, { phase, deadlineAt })
    }
    if (record.installAttempts >= MAX_ATTEMPTS) {
      publish('manual')
      return
    }
    if (this.attempted.has(this.attemptKey(update))) {
      publish('retry-next-launch')
      return
    }
    const now = Date.now()
    if (now < deadlineAt) {
      const snoozeEnd = Math.min(record.snoozedUntil ?? 0, deadlineAt)
      publish(snoozeEnd > now ? 'snoozed' : 'ready')
      this.wakeAt(update, snoozeEnd > now ? snoozeEnd : deadlineAt)
      return
    }
    if (record.countdownStartedAt === undefined || record.countdownStartedAt < deadlineAt) {
      record.countdownStartedAt = now
      await update.store.write(record)
      if (this.deadline(update) !== deadlineAt) {
        return
      }
    }
    const countdownEndsAt = record.countdownStartedAt + COUNTDOWN_MS
    if (now < countdownEndsAt) {
      this.ports.publish(record.version, { phase: 'countdown', deadlineAt, countdownEndsAt })
      this.wakeAt(update, countdownEndsAt)
      return
    }
    const agentCutoff = deadlineAt + AGENT_DEFERRAL_MS
    if (now < agentCutoff && this.ports.hasWorkingAgents()) {
      publish('waiting-for-agents')
      this.wakeAt(update, Math.min(now + AGENT_RECHECK_MS, agentCutoff))
      return
    }
    this.ports.install()
  }
}
