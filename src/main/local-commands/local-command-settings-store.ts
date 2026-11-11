import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomically } from '../filesystem/atomic-file-publication'
import { assessLocalCommandRisk } from '../../shared/local-commands/local-command-risk'
import {
  LOCAL_COMMAND_MAX_COMMAND_CHARS,
  LOCAL_COMMAND_MAX_CWD_CHARS
} from '../../shared/local-commands/local-command-contract'

const MAX_RULES = 200
/** A saved approval lapses; the person sees the command again after this long. */
export const LOCAL_COMMAND_RULE_TTL_MS = 30 * 24 * 60 * 60_000
const SandboxId = z.string().regex(/^sbx_[0-9a-f]{24}$/)

const WorkspaceSettingSchema = z.object({
  enabled: z.boolean(),
  sharedAllowed: z.boolean(),
  updatedAt: z.number()
})

const RuleSchema = z.object({
  id: z.string().min(1).max(64),
  sandboxId: SandboxId,
  command: z.string().min(1).max(LOCAL_COMMAND_MAX_COMMAND_CHARS),
  cwd: z
    .string()
    .min(1)
    .max(LOCAL_COMMAND_MAX_CWD_CHARS * 4),
  createdAt: z.number()
})

const FileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(SandboxId, WorkspaceSettingSchema),
  rules: z.array(RuleSchema).max(MAX_RULES)
})

export type LocalCommandWorkspaceSetting = z.infer<typeof WorkspaceSettingSchema>
export type LocalCommandRule = z.infer<typeof RuleSchema>
type LocalCommandSettingsFile = z.infer<typeof FileSchema>

const EMPTY: LocalCommandSettingsFile = { version: 1, workspaces: {}, rules: [] }

export function isLocalCommandSandboxId(value: unknown): value is string {
  return SandboxId.safeParse(value).success
}

/**
 * Per-workspace switches and "Always allow" rules, on this computer only (never synced: they are
 * this computer's consent). Off when absent; an unreadable file reads as everything off.
 */
export class LocalCommandSettingsStore {
  private cached: LocalCommandSettingsFile | null = null
  private readonly path: string

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'local-commands.json')
  }

  workspace(sandboxId: string): LocalCommandWorkspaceSetting | null {
    return this.read().workspaces[sandboxId] ?? null
  }

  enabledSandboxIds(): string[] {
    return Object.entries(this.read().workspaces)
      .filter(([, setting]) => setting.enabled)
      .map(([sandboxId]) => sandboxId)
  }

  setEnabled(sandboxId: string, enabled: boolean, sharedAllowed: boolean, now: number): void {
    const next = this.read()
    if (enabled) {
      const previous = next.workspaces[sandboxId]
      next.workspaces[sandboxId] = { enabled, sharedAllowed, updatedAt: now }
      // Rules approved while only the owner could prompt the agent don't carry over to a shared one.
      if (sharedAllowed && !previous?.sharedAllowed) {
        next.rules = next.rules.filter((rule) => rule.sandboxId !== sandboxId)
      }
    } else {
      // Turning it off also forgets this workspace's "Always allow" rules: the next time it is on,
      // every command is asked about again.
      delete next.workspaces[sandboxId]
      next.rules = next.rules.filter((rule) => rule.sandboxId !== sandboxId)
    }
    this.write(next)
  }

  /** Rules still in force (expired ones are kept on disk until the next write drops them). */
  rules(now: number): LocalCommandRule[] {
    return this.read().rules.filter((rule) => now - rule.createdAt < LOCAL_COMMAND_RULE_TTL_MS)
  }

  /** Exact match only: same workspace, same characters, same resolved folder, not expired. */
  findRule(sandboxId: string, command: string, cwd: string, now: number): LocalCommandRule | null {
    return (
      this.rules(now).find(
        (rule) => rule.sandboxId === sandboxId && rule.command === command && rule.cwd === cwd
      ) ?? null
    )
  }

  addRule(sandboxId: string, command: string, cwd: string, now: number): LocalCommandRule | null {
    if (assessLocalCommandRisk(command, cwd).alwaysAllowBlocked) {
      return null
    }
    const existing = this.findRule(sandboxId, command, cwd, now)
    if (existing) {
      return existing
    }
    const next = this.read()
    const rule: LocalCommandRule = { id: randomUUID(), sandboxId, command, cwd, createdAt: now }
    // Oldest first out at the cap; a forgotten rule only means one more prompt.
    next.rules = [
      ...next.rules.filter((r) => now - r.createdAt < LOCAL_COMMAND_RULE_TTL_MS),
      rule
    ].slice(-MAX_RULES)
    this.write(next)
    return rule
  }

  removeRule(id: string): boolean {
    const next = this.read()
    const before = next.rules.length
    next.rules = next.rules.filter((rule) => rule.id !== id)
    if (next.rules.length === before) {
      return false
    }
    this.write(next)
    return true
  }

  /** Reads the file once; until then (or if it's unreadable) everything reads as off. */
  async load(): Promise<void> {
    if (this.cached) {
      return
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      this.cached = parsed.success ? parsed.data : structuredClone(EMPTY)
    } catch {
      this.cached = structuredClone(EMPTY)
    }
  }

  private read(): LocalCommandSettingsFile {
    return structuredClone(this.cached ?? EMPTY)
  }

  private write(next: LocalCommandSettingsFile): void {
    if (!this.cached) {
      // Never overwrite a file this run hasn't read.
      throw new Error('local command settings are not loaded')
    }
    writeFileAtomically(this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    this.cached = next
  }
}
