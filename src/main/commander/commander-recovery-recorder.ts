import { join } from 'node:path'
import { epoch, readConsent, type Principal } from './commander-recovery-account'
import { RecoveryIntents } from './commander-recovery-intents'
import { RecoveryOutbox, writeRecoveryJson } from './commander-recovery-outbox'
import { readRecoveryObservation, type RecoveryRecord } from './commander-recovery-observation'
import { recoveryEntry } from './commander-recovery-entry'
import { publishRecoveryMemory } from './commander-memory-service'
export class CommanderRecoveryRecorder {
  private readonly outbox: RecoveryOutbox
  private readonly directory: string
  readonly started = Date.now()
  private readonly ticket: string
  private readonly observed = new Map<string, string>()
  private readonly intents: RecoveryIntents
  private pending = false
  private busy = false
  private stopped = false
  private readonly stageRetries = new Map<string, ReturnType<typeof setTimeout>>()
  private retry: ReturnType<typeof setTimeout> | undefined
  error: string | null = null

  constructor(
    private readonly runtime: Parameters<typeof readRecoveryObservation>[0],
    readonly owner: Principal,
    readonly generation: string
  ) {
    this.directory = join(owner.directory, generation)
    this.ticket = owner.ticket
    this.intents = new RecoveryIntents(this.directory)
    this.outbox = new RecoveryOutbox(
      this.directory,
      async (entry) => {
        const state = await publishRecoveryMemory(owner.account, entry, () => this.check())
        await this.check()
        if (state === 'synced') {
          await writeRecoveryJson(join(this.directory, 'last-synced'), Date.now())
        }
        this.error = null
      },
      () => {
        this.error = 'sync'
      }
    )
    this.outbox.wake()
    void this.capture()
  }

  current(): boolean {
    return !this.stopped && this.ticket === epoch(this.owner.account)
  }
  private async check(): Promise<void> {
    if (
      !this.current() ||
      (await readConsent(this.owner.directory)) !== this.generation ||
      !this.current()
    ) {
      throw new Error('Recovery recording authorization changed.')
    }
  }
  private readonly inheritedOpen = new Map<string, number>()
  baseline(records: readonly RecoveryRecord[]): void {
    this.inheritedOpen.clear()
    for (const record of records) {
      if (record.lastTurn?.state === 'open') {
        this.inheritedOpen.set(record.sessionId, record.lastTurn.at)
      }
    }
  }
  observe(id: string, record: RecoveryRecord | null): void {
    if (!this.current()) {
      return
    }
    if (!record) {
      this.observed.delete(id)
      this.inheritedOpen.delete(id)
      return
    }
    const inherited = this.inheritedOpen.get(id)
    if (
      inherited !== undefined &&
      record.lastTurn?.state === 'open' &&
      record.lastTurn.at > inherited &&
      record.lastTurn.at >= this.started
    ) {
      this.inheritedOpen.delete(id)
    }
    if (this.inheritedOpen.has(id)) {
      if (record.lastTurn?.state !== 'open') {
        this.inheritedOpen.delete(id)
      }
      if (record.lastTurn) {
        this.observed.set(id, JSON.stringify(record.lastTurn))
      }
      return
    }
    const turn = record.lastTurn
    const { location, provider } = record
    if (
      (provider !== 'codex' && provider !== 'claude') ||
      location.workspaceKind !== 'git-worktree' ||
      location.executionHostId !== 'local' ||
      location.wslDistro ||
      !turn?.prompt?.trim() ||
      turn.at < this.started
    ) {
      return
    }
    const signature = JSON.stringify(turn)
    if (this.observed.get(id) === signature) {
      return
    }
    this.observed.set(id, signature)
    this.stage(id, record, signature)
  }

  private stage(id: string, record: RecoveryRecord, signature: string): void {
    clearTimeout(this.stageRetries.get(id))
    this.stageRetries.delete(id)
    void this.intents
      .stage(record)
      .then(() => {
        if (this.current()) {
          void this.capture()
        }
      })
      .catch(() => {
        if (!this.current() || this.observed.get(id) !== signature) {
          return
        }
        this.error = 'capture'
        const timer = setTimeout(() => {
          this.stageRetries.delete(id)
          if (this.current() && this.observed.get(id) === signature) {
            this.stage(id, record, signature)
          }
        }, 5000)
        timer.unref()
        this.stageRetries.set(id, timer)
      })
  }

  private async capture(): Promise<void> {
    this.pending = true
    if (this.busy || this.retry || !this.current()) {
      return
    }
    this.busy = true
    try {
      while (this.current()) {
        this.pending = false
        const record = await this.intents.next()
        if (!this.current() || !record) {
          break
        }
        const observation = await readRecoveryObservation(this.runtime, record)
        if (!this.current()) {
          break
        }
        if (observation) {
          await this.outbox.put(recoveryEntry(observation, this.generation, record.initialGoal))
        }
        if (this.current()) {
          await this.intents.ack(record)
        }
      }
    } catch {
      if (this.current()) {
        this.error = 'capture'
        this.retry = setTimeout(() => {
          this.retry = undefined
          void this.capture()
        }, 5000)
        this.retry.unref()
      }
    } finally {
      this.busy = false
      if (this.current() && this.pending && !this.retry) {
        void this.capture()
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.stageRetries.values()) {
      clearTimeout(timer)
    }
    this.stageRetries.clear()
    clearTimeout(this.retry)
    this.pending = false
    this.observed.clear()
    await Promise.all([this.outbox.stop(), this.intents.stop()])
  }
}
