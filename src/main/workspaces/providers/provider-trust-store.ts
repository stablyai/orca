import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import {
  MAX_WORKTREE_PROVIDER_TRUST_FILE_BYTES,
  parseWorktreeProviderTrustFile,
  type WorktreeProviderTrustFile
} from '../../../shared/worktree/provider/worktree-provider-trust'

export function getUserWorktreeProvidersPath(home = homedir()): string {
  return (
    process.env.ORCA_WORKTREE_PROVIDERS_PATH?.trim() ||
    join(home, '.orca', 'worktree-providers.yaml')
  )
}

export function getUserWorktreeProviderTrustPath(home = homedir()): string {
  return (
    process.env.ORCA_WORKTREE_PROVIDERS_TRUST_PATH?.trim() ||
    join(home, '.orca', 'worktree-providers-trust.json')
  )
}

export async function readWorktreeProviderTrustFile(
  path = getUserWorktreeProviderTrustPath()
): Promise<WorktreeProviderTrustFile> {
  try {
    const { buffer } = await readNodeFileWithinLimit(path, MAX_WORKTREE_PROVIDER_TRUST_FILE_BYTES, {
      regularFileOnly: true
    })
    return parseWorktreeProviderTrustFile(buffer.toString('utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { repos: {} }
    }
    throw error
  }
}

export async function writeWorktreeProviderTrustFile(
  file: WorktreeProviderTrustFile,
  path = getUserWorktreeProviderTrustPath()
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify({ repos: file.repos }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await rename(tempPath, path)
}
