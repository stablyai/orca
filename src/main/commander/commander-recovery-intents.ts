import { createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { AGENT_TURN_OUTCOMES } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import { AGENT_SESSION_TURN_PREVIEW_CHARS } from '../../shared/agent-session/lifecycle/records/agent-session-last-turn'
import { readNodeFileWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import type { RecoveryRecord } from './commander-recovery-observation'
import { writeRecoveryJson } from './commander-recovery-outbox'

const preview = z.string().max(AGENT_SESSION_TURN_PREVIEW_CHARS)
const sourceTurn = z.object({
  sessionId: z.string().min(1).max(256),
  provider: z.enum(['codex', 'claude']),
  location: z.object({
    workspaceId: z.string().min(1).max(32768),
    executionHostId: z.literal('local'),
    workspaceKind: z.literal('git-worktree'),
    wslDistro: z.null()
  }),
  lastTurn: z.object({
    state: z.enum(['open', 'settled']),
    at: z.number().int().nonnegative(),
    outcome: z.enum(AGENT_TURN_OUTCOMES).optional(),
    prompt: preview.refine((text) => text.trim().length > 0),
    reply: preview.optional()
  })
})

const intent = sourceTurn.extend({ initialGoal: preview.optional() })

const nameOf = (id: string): string => createHash('sha256').update(id).digest('hex')

/** Stage account-owned turn edges before Git lookup. A newer edge may arrive while its predecessor is being enriched. */
export class RecoveryIntents {
  private readonly directory: string
  private disk: Promise<void> = Promise.resolve()
  private files: Set<string> | null = null
  private stopped = false

  constructor(generationDirectory: string) {
    this.directory = join(generationDirectory, 'intents')
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.disk.then(operation)
    this.disk = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private async names(): Promise<Set<string>> {
    if (!this.files) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      this.files = new Set(
        (await readdir(this.directory)).filter((name) => /^[0-9a-f]{64}$/.test(name))
      )
    }
    return this.files
  }

  stage(record: RecoveryRecord): Promise<void> {
    const parsed = sourceTurn.safeParse(record)
    if (!parsed.success || this.stopped) {
      return Promise.resolve()
    }
    if (parsed.data.lastTurn.state === 'open') {
      delete parsed.data.lastTurn.reply
    }
    return this.serialized(async () => {
      if (this.stopped) {
        return
      }
      const files = await this.names()
      const name = nameOf(parsed.data.sessionId)
      const next = parsed.data
      const prior = files.has(name) ? await this.read(name) : null
      const initialGoal =
        prior?.location.workspaceId === next.location.workspaceId &&
        prior.provider === next.provider
          ? (prior.initialGoal ?? prior.lastTurn.prompt)
          : next.lastTurn.prompt
      const value = initialGoal === next.lastTurn.prompt ? next : { ...next, initialGoal }
      if (await writeRecoveryJson(join(this.directory, name), value, () => !this.stopped)) {
        files.add(name)
      }
    })
  }

  private async read(name: string): Promise<z.infer<typeof intent>> {
    const raw = (await readNodeFileWithinLimit(join(this.directory, name), 262144)).buffer
    const record = intent.parse(JSON.parse(raw.toString('utf8')))
    if (nameOf(record.sessionId) !== name) {
      throw new Error('Unexpected recovery intent.')
    }
    return record
  }

  next(): Promise<z.infer<typeof intent> | null> {
    return this.serialized(async () => {
      if (this.stopped) {
        return null
      }
      const files = await this.names()
      const first = files.values().next()
      if (first.done) {
        return null
      }
      const name = first.value
      // Rotate before reading so an unreadable entry cannot starve the rest after retry.
      files.delete(name)
      files.add(name)
      return this.read(name)
    })
  }

  ack(record: RecoveryRecord): Promise<void> {
    return this.serialized(async () => {
      if (this.stopped) {
        return
      }
      const files = await this.names()
      const name = nameOf(record.sessionId)
      if (files.has(name)) {
        const path = join(this.directory, name)
        const raw = (await readNodeFileWithinLimit(path, 262144)).buffer.toString('utf8')
        if (raw === JSON.stringify(intent.parse(record))) {
          await rm(path)
          files.delete(name)
        }
      }
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.disk
  }
}
