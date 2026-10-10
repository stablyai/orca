import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import { buildGhosttyConfig } from './ghostty-native-terminal-config'

let lastConfigText: string | null = null

export function ghosttyConfigPath(): string {
  const dir = join(app.getPath('userData'), 'native-terminal')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'ghostty.conf')
}

// The path only when the text changed, so callers skip a Ghostty reload otherwise.
export function writeGhosttyConfig(
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): string | null {
  const text = buildGhosttyConfig(appearance, zoomFactor)
  if (text === lastConfigText) {
    return null
  }
  lastConfigText = text
  const path = ghosttyConfigPath()
  writeFileSync(path, text)
  return path
}
