// "Move to this computer": transfer folders left on disk. Prepared transfers live only in memory, so
// a folder found at startup is abandoned unless an apply was attempted on it (then it is kept, and
// offered for "Apply changes again", for 30 days).
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CloudTransferPending } from '../../shared/hosted-sandbox/cloud-transfer-api'
import {
  PersistedTransferSchema,
  TRANSFER_STATE_FILE,
  loadPersistedTransfer
} from './cloud-transfer-apply'

const LEFTOVER_TTL_MS = 30 * 86_400_000

/**
 * Prepared transfers live only in memory, so anything on disk at startup is abandoned: removed,
 * except saved patches that did not apply (the user's work), which are kept for 30 days.
 */
export async function sweepCloudTransfers(root: string, now: number): Promise<number> {
  let removed = 0
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) {
      continue
    }
    const dir = join(root, entry.name)
    const leftovers = await stat(join(dir, 'unapplied')).catch(() => null)
    if (leftovers && now - leftovers.mtimeMs < LEFTOVER_TTL_MS) {
      continue
    }
    // An apply was attempted but did not finish: keep it so "Apply changes again" still works.
    if (await appliedAttemptWithin(dir, now)) {
      continue
    }
    await rm(dir, { recursive: true, force: true })
    removed++
  }
  return removed
}

export async function persistedWorktreePath(dir: string): Promise<string | null> {
  try {
    const parsed = PersistedTransferSchema.safeParse(
      JSON.parse(await readFile(join(dir, TRANSFER_STATE_FILE), 'utf8'))
    )
    return parsed.success ? (parsed.data.worktreePath ?? null) : null
  } catch {
    return null
  }
}

async function appliedAttemptWithin(dir: string, now: number): Promise<boolean> {
  const info = await stat(join(dir, TRANSFER_STATE_FILE)).catch(() => null)
  if (!info || now - info.mtimeMs >= LEFTOVER_TTL_MS) {
    return false
  }
  return (await persistedWorktreePath(dir)) !== null
}

/** Transfers whose apply was attempted but left something behind (shown after a restart). */
export async function listPendingCloudTransfers(root: string): Promise<CloudTransferPending[]> {
  const pending: CloudTransferPending[] = []
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) {
      continue
    }
    const dir = join(root, entry.name)
    const transfer = await loadPersistedTransfer(dir)
    const worktreePath = await persistedWorktreePath(dir)
    if (!transfer || !worktreePath) {
      continue
    }
    pending.push({
      transferId: entry.name,
      workspaceId: transfer.workspaceId,
      worktreePath,
      leftoverDir: join(dir, 'unapplied')
    })
  }
  return pending
}
