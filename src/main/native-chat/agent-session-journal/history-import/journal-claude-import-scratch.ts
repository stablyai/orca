import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RESERVE_BYTES = 512 * 1024 * 1024
const QUOTA_BYTES = 4 * 1024 * 1024 * 1024

function bytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name)
    return total + (entry.isDirectory() ? bytes(child) : statSync(child).size)
  }, 0)
}

function sweep(parent: string) {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('operation-')) continue
    const path = join(parent, entry.name)
    let pid: number
    try { pid = Number(readFileSync(join(path, 'owner'), 'utf8')) } catch { continue }
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(path, { recursive: true, force: true })
    }
  }
}

export function createClaudeImportScratch(options: { quotaBytes?: number; reserveBytes?: number } = {}) {
  const parent = join(tmpdir(), 'orca-claude-imports')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  sweep(parent)
  if (bytes(parent) >= (options.quotaBytes ?? QUOTA_BYTES)) throw new Error('Claude history import scratch quota is full.')
  const root = mkdtempSync(join(parent, 'operation-'))
  writeFileSync(join(root, 'owner'), String(process.pid), { mode: 0o600 })
  const free = statfsSync(root)
  if (Number(free.bavail) * Number(free.bsize) < (options.reserveBytes ?? RESERVE_BYTES)) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('Claude history import needs more free disk space.')
  }
  return { root, filename: join(root, 'graph.sqlite'), close: () => rmSync(root, { recursive: true, force: true }) }
}
