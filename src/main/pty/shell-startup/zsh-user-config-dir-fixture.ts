/** Ownership checks require a real startup file, so config-dir fixtures cannot be made-up paths. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function makeUserZdotdir(parent: string, ...segments: string[]): string {
  const dir = join(parent, ...segments)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.zshrc'), '')
  return dir
}
