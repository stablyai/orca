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
  chord: z.string().refine((chord) => CLAUDE_AGENT_VIEW_SHORTCUTS.some((s) => s.chord === chord)),
  seenAt: z.number(),
  configDir: z.string().min(1).max(4096).optional(),
  view: ClaudeAgentViewObservation.optional()
})
export type RegisteredClaudeAgentView = z.infer<typeof RegisteredView>

const RegistryFile = z.object({
  version: z.literal(1),
  sessions: z.array(RegisteredView).max(MAX_CLAUDE_AGENT_VIEW_SESSIONS)
})

async function readRegistry(filePath: string): Promise<RegisteredClaudeAgentView[]> {
  try {
    const parsed = RegistryFile.safeParse(JSON.parse(await readFile(filePath, 'utf8')))
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

/** Saves off the main thread, one write at a time; a change during a write is saved right after it. */
export class ClaudeAgentViewRegistryFile {
  private writing?: Promise<void>
  private latest?: readonly RegisteredClaudeAgentView[]
  private failed = false
  private restoring = false
  private savedDuringRestore = false
  private closed = false

  constructor(
    readonly filePath: string,
    private readonly current: () => readonly RegisteredClaudeAgentView[]
  ) {}

  /** `merge` folds the saved entries into memory and says whether memory now differs from the file.
   *  Saves wait until then, so an early registration cannot overwrite entries not merged yet. */
  async restore(merge: (saved: RegisteredClaudeAgentView[]) => boolean): Promise<void> {
    this.restoring = true
    const saved = await readRegistry(this.filePath)
    this.restoring = false
    if (this.closed) {
      return
    }
    const changed = merge(saved)
    if (changed || this.savedDuringRestore) {
      void this.save()
    }
    this.savedDuringRestore = false
  }

  /** Stop: a write already queued still lands; nothing new is written. */
  close(): void {
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
    this.latest = this.current()
    this.writing ??= this.drain().finally(() => {
      this.writing = undefined
    })
    return this.writing
  }

  private async drain(): Promise<void> {
    while (this.latest) {
      const sessions = this.latest
      this.latest = undefined
      try {
        await writeRegistry(this.filePath, sessions)
        this.failed = false
      } catch (error) {
        if (!this.failed) {
          console.warn('[agent-hooks] failed to save Claude agent views:', error)
        }
        this.failed = true
      }
    }
  }
}
