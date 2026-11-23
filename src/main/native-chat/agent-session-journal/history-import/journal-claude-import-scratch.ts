import { mkdtempSync, rmSync, statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RESERVE_BYTES = 512 * 1024 * 1024

export function createClaudeImportScratch() {
  const root = mkdtempSync(join(tmpdir(), 'orca-claude-import-'))
  const free = statfsSync(root)
  if (Number(free.bavail) * Number(free.bsize) < RESERVE_BYTES) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('Claude history import needs more free disk space.')
  }
  return { filename: join(root, 'graph.sqlite'), close: () => rmSync(root, { recursive: true, force: true }) }
}
