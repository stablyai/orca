import { writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { IdeLockfile } from './ide-protocol-types'

function lockfilePath(ideDir: string, port: number): string {
  return join(ideDir, `${port}.lock`)
}

export function writeLockfile(ideDir: string, port: number, data: IdeLockfile): void {
  // mode 0o600: lockfile carries the auth token, keep it owner-only.
  writeFileSync(lockfilePath(ideDir, port), JSON.stringify(data), { mode: 0o600 })
}

export function removeLockfile(ideDir: string, port: number): void {
  rmSync(lockfilePath(ideDir, port), { force: true })
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function sweepOrphanLockfiles(ideDir: string): void {
  if (!existsSync(ideDir)) {return}
  for (const name of readdirSync(ideDir)) {
    if (!name.endsWith('.lock')) {continue}
    try {
      const data = JSON.parse(readFileSync(join(ideDir, name), 'utf8')) as IdeLockfile
      if (!isPidAlive(data.pid)) {rmSync(join(ideDir, name), { force: true })}
    } catch {
      rmSync(join(ideDir, name), { force: true })
    }
  }
}
