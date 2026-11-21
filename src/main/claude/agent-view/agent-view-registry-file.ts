import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writePluginFileAtomically } from '../../plugins/installation/plugin-atomic-file-write'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import {
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  ClaudeAgentViewObservation
} from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

export const MAX_CLAUDE_AGENT_VIEW_SESSIONS = 1024

export const ClaudeAgentViewIdentity = z.object({
  paneKey: z
    .string()
    .max(256)
    .refine((value) => parsePaneKey(value) !== null),
  sessionId: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256)
})

const RegisteredView = ClaudeAgentViewIdentity.extend({
  chord: z
    .string()
    .refine((chord) => CLAUDE_AGENT_VIEW_SHORTCUTS.some((s) => s.chord === chord))
    .optional(),
  seenAt: z.number(),
  configDir: z.string().min(1).max(4096).optional(),
  view: ClaudeAgentViewObservation.optional()
})
export type RegisteredClaudeAgentView = z.infer<typeof RegisteredView>

const RegistryFile = z.object({
  version: z.literal(1),
  sessions: z.array(RegisteredView).max(MAX_CLAUDE_AGENT_VIEW_SESSIONS)
})

/** undefined: the file exists but could not be read now (a lock), so the caller retries. */
async function readRegistry(filePath: string): Promise<RegisteredClaudeAgentView[] | undefined> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? [] : undefined
  }
  try {
    const parsed = RegistryFile.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data.sessions : []
  } catch {
    return []
  }
}

async function writeRegistry(
  filePath: string,
  sessions: readonly RegisteredClaudeAgentView[]
): Promise<void> {
  if (sessions.length === 0) {
    await rm(filePath, { force: true })
    return
  }
  await mkdir(dirname(filePath), { recursive: true })
  await writePluginFileAtomically(filePath, JSON.stringify({ version: 1, sessions }))
}

/** Saves off the main thread, one write at a time; changes during a write coalesce into one more,
 *  and memory is copied once per write, not once per change. */
export class ClaudeAgentViewRegistryFile {
  private writing?: Promise<void>
  private dirty = false
  // Fixed at close (memory is about to be cleared) or for a failed write's retry after close.
  private frozen?: readonly RegisteredClaudeAgentView[]
  private failed = false
  private failedWrites = 0
  private failedAt = 0
  private restoring = false
  private savedDuringRestore = false
  private closed = false
  private restored: Promise<void> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly current: () => readonly RegisteredClaudeAgentView[]
  ) {}

  /** `merge` folds the saved entries into memory and says whether memory now differs from the file.
   *  Saves wait until then, so an early registration cannot overwrite entries not merged yet. */
  restore(merge: (saved: RegisteredClaudeAgentView[]) => boolean): Promise<void> {
    this.restoring = true
    this.restored = this.merge(merge)
    return this.restored
  }

  private async merge(merge: (saved: RegisteredClaudeAgentView[]) => boolean): Promise<void> {
    let saved = await readRegistry(this.filePath)
    // Idle mods will not register again, so a locked file is retried (2 s doubling, four times).
    for (let attempt = 1; saved === undefined && attempt <= 4 && !this.closed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      saved = await readRegistry(this.filePath)
    }
    this.restoring = false
    if (saved === undefined) {
      // Still locked: never overwrite entries this run could not read. Without saves nothing is
      // durable, so every mod keeps its 5 s check-in instead of going quiet.
      this.closed = true
    }
    if (this.closed) {
      return
    }
    const changed = merge(saved)
    if (changed || this.savedDuringRestore) {
      void this.save()
    }
    this.savedDuringRestore = false
  }

  /** Whether memory is on disk, waiting up to `ms` for the restore and the writes in flight. */
  async settled(ms = 2000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
    if (this.failed && !this.writing && Date.now() - this.failedAt >= 30_000) {
      void this.save() // storage may be back; nothing else would write again
    }
    const done = (async () => {
      await this.restored
      while (this.writing) {
        await this.writing
      }
      return !this.failed && !this.closed
    })()
    try {
      return await Promise.race([done, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Stop: a write already queued still lands; nothing new is written. */
  close(): void {
    if (this.dirty) {
      this.frozen = this.current()
    }
    this.closed = true
  }

  save(): Promise<void> {
    if (this.closed) {
      return this.writing ?? Promise.resolve()
    }
    if (this.restoring) {
      this.savedDuringRestore = true
      return Promise.resolve()
    }
    this.dirty = true
    this.startDrain()
    return this.writing ?? Promise.resolve()
  }

  private startDrain(): void {
    this.writing ??= this.drain().finally(() => {
      this.writing = undefined
      // A save between the loop's last check and this cleanup set dirty without a drain.
      if (this.dirty) {
        this.startDrain()
      }
    })
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false
      const sessions = this.frozen ?? this.current()
      this.frozen = undefined
      try {
        await writeRegistry(this.filePath, sessions)
        this.failed = false
        this.failedWrites = 0
      } catch (error) {
        if (!this.failed) {
          console.warn('[agent-hooks] failed to save Claude agent views:', error)
        }
        this.failed = true
        this.failedAt = Date.now()
        // Idle mods will not register again, so retry (2 s doubling, five times); a later change retries too.
        if (++this.failedWrites <= 5) {
          if (!this.dirty && this.closed) {
            this.frozen = sessions
          }
          this.dirty = true
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** this.failedWrites))
        }
      }
    }
  }
}
