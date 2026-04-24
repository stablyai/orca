import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  renameSync,
  unlinkSync
} from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

export type HookCommandConfig = {
  type: 'command'
  command: string
  timeout?: number
  [key: string]: unknown
}

export type HookDefinition = {
  matcher?: string
  hooks?: HookCommandConfig[]
  [key: string]: unknown
}

export type HooksConfig = {
  hooks?: Record<string, HookDefinition[]>
  [key: string]: unknown
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readHooksJson(configPath: string): HooksConfig | null {
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Why: callers in install/remove need to match not just the exact current
// managed command, but also stale entries pointing at old script paths — e.g.
// from a previous dev build with a different Electron userData dir, or a
// parallel dev/prod install. Matching by the managed script's file name
// (under any `agent-hooks/` directory) lets a fresh install sweep those
// without touching unrelated user-authored hooks.
export function createManagedCommandMatcher(
  scriptFileName: string
): (command: string | undefined) => boolean {
  const needle = `agent-hooks/${scriptFileName}`
  return (command) => {
    if (!command) {
      return false
    }
    return command.replaceAll('\\', '/').includes(needle)
  }
}

export function removeManagedCommands(
  definitions: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean
): HookDefinition[] {
  return definitions.flatMap((definition) => {
    if (!Array.isArray(definition.hooks)) {
      return [definition]
    }

    const filteredHooks = definition.hooks.filter((hook) => !isManagedCommand(hook.command))
    if (filteredHooks.length === 0) {
      return []
    }

    return [{ ...definition, hooks: filteredHooks }]
  })
}

export function writeManagedScript(scriptPath: string, content: string): void {
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, content, 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(scriptPath, 0o755)
  }
}

export function writeHooksJson(configPath: string, config: HooksConfig): void {
  const dir = dirname(configPath)
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

  // Why: skip the write (and therefore the .bak rotation) when the on-disk
  // content is already identical. Without this, every install() rewrites the
  // file and rolls the backup forward, which can silently destroy the last
  // recoverable copy if install() is called repeatedly (e.g. on app start).
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === serialized) {
        return
      }
    } catch {
      // Fall through to the normal write path — a read error here is not
      // worth failing the install for; the atomic write below will either
      // succeed or throw loudly.
    }
  }

  try {
    writeFileSync(tmpPath, serialized, 'utf-8')
    // Why: single rolling backup — one file, no accumulation in ~/.claude.
    // Protects against a merge-logic bug producing bad JSON; the original is
    // always recoverable from <configPath>.bak until the next write.
    if (existsSync(configPath)) {
      copyFileSync(configPath, `${configPath}.bak`)
    }
    renameSync(tmpPath, configPath)
  } finally {
    // Clean up temp file if rename failed.
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}
