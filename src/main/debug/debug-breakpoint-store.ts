import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type * as Wire from '../../preload/api/debug-api'
import { renameFileWithWindowsRetry, writeFileAtomically } from '../codex-accounts/fs-utils'

export class DebugServiceError extends Error {
  constructor(
    readonly reason: Wire.DebugRefusalReason,
    message: string
  ) {
    super(message)
    this.name = 'DebugServiceError'
  }
}

/** Who last set a breakpoint's code fields (condition, hitCondition, logMessage). */
export type DebugAuthor = 'ui' | 'cli'

export type DebugBreakpoint = {
  id: string
  line: number
  column?: number
  enabled: boolean
  condition?: string
  hitCondition?: string
  logMessage?: string
  /** The store always records it; a literal without one counts as a person's. */
  author?: DebugAuthor
}

export type DebugBreakpointInput = Omit<DebugBreakpoint, 'id' | 'enabled' | 'author'> & {
  enabled?: boolean
  author?: DebugAuthor
}
export type DebugBreakpointPatch = Partial<Omit<DebugBreakpoint, 'id'>>

type RootTable = Record<string, DebugBreakpoint[]>
type StoreFile = { version: 1; roots: Record<string, RootTable> }

/** Realpath with case preserved, so /tmp and /private/tmp agree; a missing tail is kept as spelled. */
export function normalizeDebugPath(path: string): string {
  const absolute = resolve(path)
  const tail: string[] = []
  let head = absolute
  for (;;) {
    try {
      return join(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) {
        return absolute
      }
      tail.unshift(basename(head))
      head = parent
    }
  }
}

/** Lexical: `path` is strictly below `root`. */
export function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Both sides realpath-normalised; the root itself is not "inside". */
export function isInsideRoot(root: string, path: string): boolean {
  return isPathInside(normalizeDebugPath(root), normalizeDebugPath(path))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The fields an adapter runs as code. */
export const CODE_FIELDS = ['condition', 'hitCondition', 'logMessage'] as const

export const WITHHELD_MESSAGE = 'agent-written condition withheld'

/** An agent's code fields never run in a session a person started. */
export function withheldFrom(bp: DebugBreakpoint, audience: DebugAuthor | null): boolean {
  return audience === 'ui' && bp.author === 'cli' && CODE_FIELDS.some((key) => bp[key])
}

function readEntry(value: unknown): DebugBreakpoint | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !Number.isSafeInteger(value.line) ||
    typeof value.enabled !== 'boolean'
  ) {
    return null
  }
  // A file written before authors were recorded holds only a person's breakpoints.
  const author = value.author === 'cli' ? 'cli' : 'ui'
  const entry: DebugBreakpoint = {
    id: value.id,
    line: Number(value.line),
    enabled: value.enabled,
    author
  }
  if (Number.isSafeInteger(value.column)) {
    entry.column = Number(value.column)
  }
  for (const key of CODE_FIELDS) {
    const field = value[key]
    if (typeof field === 'string') {
      entry[key] = field
    }
  }
  return entry
}

function readStoreFile(text: string): Map<string, Map<string, DebugBreakpoint[]>> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.roots)) {
    return null
  }
  const roots = new Map<string, Map<string, DebugBreakpoint[]>>()
  for (const [root, files] of Object.entries(parsed.roots)) {
    if (!isRecord(files)) {
      return null
    }
    const table = new Map<string, DebugBreakpoint[]>()
    for (const [file, entries] of Object.entries(files)) {
      if (!Array.isArray(entries)) {
        return null
      }
      const read = entries.map(readEntry)
      if (read.some((entry) => entry === null)) {
        return null
      }
      table.set(
        file,
        read.filter((entry): entry is DebugBreakpoint => entry !== null)
      )
    }
    roots.set(root, table)
  }
  return roots
}

function sanitizePatch(patch: DebugBreakpointPatch): DebugBreakpointPatch {
  const clean: DebugBreakpointPatch = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      Object.assign(clean, { [key]: value })
    }
  }
  return clean
}

export type DebugBreakpointStoreOptions = {
  /** JSON file the store persists to; read once at construction. */
  filePath: string
  warn?: (message: string) => void
}

/** The single source of breakpoints for UI and CLI, keyed by worktree root then absolute file. */
export class DebugBreakpointStore {
  private readonly roots = new Map<string, Map<string, DebugBreakpoint[]>>()
  private readonly listeners = new Set<(root: string, file: string) => void>()
  private readonly audiences = new Map<string, DebugAuthor>()
  private readonly warn: (message: string) => void

  constructor(private readonly options: DebugBreakpointStoreOptions) {
    this.warn = options.warn ?? ((message) => console.warn(`[debug] ${message}`))
    this.load()
  }

  /** Files under `root` that hold at least one breakpoint. */
  files(root: string): string[] {
    return [...(this.roots.get(normalizeDebugPath(root))?.keys() ?? [])]
  }

  forFile(root: string, file: string): DebugBreakpoint[] {
    const entries = this.roots.get(normalizeDebugPath(root))?.get(normalizeDebugPath(file)) ?? []
    return entries.map((entry) => ({ ...entry }))
  }

  /** The origin of the session `root` runs now; unset counts as a person's. */
  setAudience(root: string, origin: DebugAuthor): void {
    this.audiences.set(normalizeDebugPath(root), origin)
  }

  /** What the session in `root` is sent: withheld entries go as plain line breakpoints. */
  forSession(root: string, file: string): DebugBreakpoint[] {
    const audience = this.audiences.get(normalizeDebugPath(root)) ?? 'ui'
    const plain = (bp: DebugBreakpoint) => {
      CODE_FIELDS.forEach((key) => delete bp[key])
      return bp
    }
    return this.forFile(root, file).map((bp) => (withheldFrom(bp, audience) ? plain(bp) : bp))
  }

  add(root: string, file: string, input: DebugBreakpointInput): DebugBreakpoint {
    const entry: DebugBreakpoint = {
      ...sanitizePatch(input),
      id: randomUUID(),
      line: input.line,
      enabled: input.enabled ?? true,
      author: input.author ?? 'ui'
    }
    this.mutate(root, file, (entries) => [...entries, entry])
    return { ...entry }
  }

  update(
    root: string,
    file: string,
    id: string,
    patch: DebugBreakpointPatch
  ): DebugBreakpoint | null {
    let updated: DebugBreakpoint | null = null
    this.mutate(root, file, (entries) =>
      entries.map((entry) => {
        if (entry.id !== id) {
          return entry
        }
        updated = { ...entry, ...sanitizePatch(patch), id }
        return updated
      })
    )
    return updated
  }

  remove(root: string, file: string, id: string): boolean {
    let removed = false
    this.mutate(root, file, (entries) => {
      const kept = entries.filter((entry) => entry.id !== id)
      removed = kept.length !== entries.length
      return kept
    })
    return removed
  }

  /** After an edit: listed ids move to their new line, unlisted ones went with deleted lines. */
  setFileLines(root: string, file: string, lines: readonly { id: string; line: number }[]): void {
    const moved = new Map(lines.map(({ id, line }) => [id, line]))
    this.mutate(root, file, (entries) => {
      const taken = new Set<number>()
      const next: DebugBreakpoint[] = []
      for (const entry of entries) {
        const line = moved.get(entry.id)
        // Two breakpoints squeezed onto one line by an edit collapse into the first.
        if (line === undefined || taken.has(line)) {
          continue
        }
        taken.add(line)
        next.push({ ...entry, line })
      }
      return next
    })
  }

  /** Called with normalized (root, file) after every change to that file. */
  onChange(listener: (root: string, file: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private mutate(
    rootPath: string,
    filePath: string,
    change: (entries: DebugBreakpoint[]) => DebugBreakpoint[]
  ): void {
    const root = normalizeDebugPath(rootPath)
    const file = normalizeDebugPath(filePath)
    const table = this.roots.get(root) ?? new Map<string, DebugBreakpoint[]>()
    const next = change(table.get(file) ?? [])
    if (next.length > 0) {
      table.set(file, next)
    } else {
      table.delete(file)
    }
    if (table.size > 0) {
      this.roots.set(root, table)
    } else {
      this.roots.delete(root)
    }
    this.persist()
    for (const listener of this.listeners) {
      try {
        listener(root, file)
      } catch (error) {
        this.warn(`breakpoint listener threw: ${String(error)}`)
      }
    }
  }

  private load(): void {
    const { filePath } = this.options
    if (!existsSync(filePath)) {
      return
    }
    let roots: Map<string, Map<string, DebugBreakpoint[]>> | null = null
    try {
      roots = readStoreFile(readFileSync(filePath, 'utf8'))
    } catch (error) {
      this.warn(`could not read breakpoints from ${filePath}: ${String(error)}`)
      return
    }
    if (!roots) {
      const aside = `${filePath}.corrupt-${Date.now()}`
      try {
        renameFileWithWindowsRetry(filePath, aside)
        this.warn(`breakpoint file ${filePath} was corrupt; moved it to ${aside} and started empty`)
      } catch (error) {
        this.warn(
          `breakpoint file ${filePath} was corrupt and could not be moved: ${String(error)}`
        )
      }
      return
    }
    // Realpath on load too: a file written as /tmp/... must answer /private/tmp/... lookups.
    for (const [rawRoot, table] of roots) {
      const root = normalizeDebugPath(rawRoot)
      const merged = this.roots.get(root) ?? new Map<string, DebugBreakpoint[]>()
      for (const [rawFile, entries] of table) {
        const file = normalizeDebugPath(rawFile)
        merged.set(file, [...(merged.get(file) ?? []), ...entries])
      }
      this.roots.set(root, merged)
    }
  }

  private persist(): void {
    const file: StoreFile = { version: 1, roots: {} }
    for (const [root, table] of this.roots) {
      file.roots[root] = Object.fromEntries(table)
    }
    try {
      mkdirSync(dirname(this.options.filePath), { recursive: true })
      const text = `${JSON.stringify(file, null, 2)}\n`
      writeFileAtomically(this.options.filePath, text, { mode: 0o600 })
    } catch (error) {
      // The in-memory store stays authoritative; a failed save must not fail the edit.
      this.warn(`could not save breakpoints to ${this.options.filePath}: ${String(error)}`)
    }
  }
}
