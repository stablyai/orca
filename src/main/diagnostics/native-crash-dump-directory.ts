import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function getNativeCrashDumpDirectory(): string {
  return join(app.getPath('logs'), 'diagnostics', 'crashpad')
}

export function ensureNativeCrashDumpDirectory(): string {
  const directory = getNativeCrashDumpDirectory()
  mkdirSync(directory, { recursive: true })
  return directory
}
