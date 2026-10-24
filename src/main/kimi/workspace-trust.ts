import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

// Kimi Code 2.1.1 keys workspace-trust records by its canonical cwd, not realpath.
export function markKimiWorkspaceTrusted(workspacePath: string, kimiHome: string): void {
  const root = resolve(workspacePath)
  const slashed = root.replaceAll('\\', '/')
  const normalized = (process.platform === 'win32' ? slashed.toLowerCase() : slashed).replace(
    /\/+$/,
    ''
  )
  const slug = basename(normalized)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  const name = !slug || slug === '.' || slug === '..' ? 'workspace' : slug
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  const directory = join(kimiHome, 'workspace-trust')
  const file = join(directory, `wd_${name}_${hash}`)
  if (existsSync(file)) {
    return
  }
  mkdirSync(directory, { recursive: true })
  writeFileAtomically(file, JSON.stringify({ root, trustedAt: Date.now() }))
}
