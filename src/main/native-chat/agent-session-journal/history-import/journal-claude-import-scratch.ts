import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
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

export function createClaudeImportScratch() {
  const parent = join(tmpdir(), 'orca-claude-imports')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (bytes(parent) >= QUOTA_BYTES) throw new Error('Claude history import scratch quota is full.')
  const root = mkdtempSync(join(parent, 'operation-'))
  writeFileSync(join(root, 'owner'), String(process.pid), { mode: 0o600 })
  const free = statfsSync(root)
  if (Number(free.bavail) * Number(free.bsize) < RESERVE_BYTES) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('Claude history import needs more free disk space.')
  }
  return { filename: join(root, 'graph.sqlite'), close: () => rmSync(root, { recursive: true, force: true }) }
}
