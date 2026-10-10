/**
 * Builds a directory that counts as a user's real zsh config root.
 *
 * Why a fixture: the inherited-ZDOTDIR guard only accepts a directory that
 * actually holds a zsh startup file, so tests can no longer use a made-up path.
 *
 * Test support only; nothing under src/main imports this at runtime.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function makeUserZdotdir(parent: string, ...segments: string[]): string {
  const dir = join(parent, ...segments)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.zshrc'), '')
  return dir
}
