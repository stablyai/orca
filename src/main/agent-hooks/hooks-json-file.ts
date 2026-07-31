// The hooks settings JSON file contract: the Claude-shaped config types and
// the local read/write primitives every managed-hook installer shares —
// atomic tmp+rename replace, rolling .bak, and the compare-and-retry
// read-modify-write used to coexist with concurrent writers (the agent CLI
// itself rewrites its settings file). Split from `installer-utils.ts`, which
// keeps the command wrapping/matching logic; both are re-exported from there
// so call sites keep a single import surface.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { writeRollingFileBackup } from '../rolling-file-backup'
import { resolveHooksJsonWritePath } from './hook-config-write-path'
import { readHooksJsonWithRaw } from './hooks-json-read'

export type HookCommandConfig = {
  type: 'command'
  command: string
  timeout?: number
  async?: boolean
  statusMessage?: string
  [key: string]: unknown
}

export type HookDefinition = {
  matcher?: string
  command?: string
  bash?: string
  powershell?: string
  hooks?: HookCommandConfig[]
  [key: string]: unknown
}

export type HooksConfig = {
  hooks?: Record<string, HookDefinition[]>
  [key: string]: unknown
}

export {
  isPlainObject,
  readHooksJson,
  readHooksJsonWithRaw,
  type HooksJsonSnapshot
} from './hooks-json-read'

/** Raw settings file content, or null when absent/unreadable. Used as the
 *  compare-and-retry baseline for read-modify-write cycles. */
export function readRawHooksFile(configPath: string): string | null {
  const readPath = resolveHooksJsonWritePath(configPath)
  if (!existsSync(readPath)) {
    return null
  }
  try {
    return readFileSync(readPath, 'utf-8')
  } catch {
    return null
  }
}

/** Read-modify-write a hooks settings file with a stale check: if another
 *  writer (the agent CLI itself, a second Orca instance) changed the file
 *  between our read and our replace, the attempt is discarded and re-run
 *  against the fresh content so no concurrent keys are lost. `mutate` may
 *  return null to signal "nothing to change" — the file
 *  is then left untouched (not created, not reformatted, no .bak roll).
 *  Returns the written (or unchanged) config, or null when the file is
 *  unparseable. */
export function updateHooksJsonWithRetry(
  configPath: string,
  mutate: (config: HooksConfig) => HooksConfig | null,
  maxAttempts = 3
): HooksConfig | null {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { raw: baseline, config } = readHooksJsonWithRaw(resolveHooksJsonWritePath(configPath))
    if (!config) {
      return null
    }
    const next = mutate(config)
    if (next === null) {
      // Why: no-op — skip the write entirely so e.g. remove() on a file that
      // holds no managed hooks neither creates a missing settings.json nor
      // rewrites (and reformats) a user file Orca never touched.
      return config
    }
    if (writeHooksJson(configPath, next, { expectedDiskContent: baseline })) {
      return next
    }
  }
  return null
}

/** Returns false only when `expectedDiskContent` was provided and the on-disk
 *  content changed since it was read (stale write aborted; nothing written). */
export function writeHooksJson(
  configPath: string,
  config: HooksConfig,
  options: { expectedDiskContent?: string | null; preserveMode?: boolean } = {}
): boolean {
  const writePath = resolveHooksJsonWritePath(configPath)
  const dir = dirname(writePath)
  mkdirSync(dir, { recursive: true })

  // Why: write to a temp file then rename so a crash or disk-full mid-write
  // leaves the original untouched. This is the only safe way to update a
  // config file the user may have hand-edited.
  //
  // Why randomUUID: Date.now() alone collides when two install() calls fire in
  // the same millisecond targeting the same dir (e.g. a future caller that
  // installs multiple agents sharing a config dir, or rapid reinstalls from
  // the settings UI). A collision would corrupt one of the two writes. The
  // UUID suffix makes the tmp path unique per call.
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  const existingMode =
    options.preserveMode === true && existsSync(writePath) ? statSync(writePath).mode : undefined

  // Why: skip the write (and therefore the .bak rotation) when the on-disk
  // content is already identical. Without this, every install() rewrites the
  // file and rolls the backup forward, which can silently destroy the last
  // recoverable copy if install() is called repeatedly (e.g. on app start).
  if (existsSync(writePath)) {
    try {
      if (readFileSync(writePath, 'utf-8') === serialized) {
        return true
      }
    } catch {
      // Fall through to the normal write path — a read error here is not
      // worth failing the install for; the atomic write below will either
      // succeed or throw loudly.
    }
  }

  try {
    writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: existingMode })
    // Why: compare-and-retry guard for concurrent writers (the agent CLI
    // rewrites its own settings.json). Re-read just before the replace; if
    // the content diverged from what the caller read, abort so the caller
    // can re-merge instead of clobbering the concurrent change.
    if (options.expectedDiskContent !== undefined) {
      if (readRawHooksFile(writePath) !== options.expectedDiskContent) {
        return false
      }
    }
    // Why: single rolling backup — one file, no accumulation in ~/.claude.
    // Protects against a merge-logic bug producing bad JSON; the original is
    // always recoverable from <configPath>.bak until the next write.
    if (existsSync(writePath)) {
      writeRollingFileBackup(writePath, `${writePath}.bak`)
    }
    renameSync(tmpPath, writePath)
  } finally {
    // Clean up temp file if rename failed (or the stale check aborted).
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
  return true
}
