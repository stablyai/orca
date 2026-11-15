import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { rewriteOrcadMigrationWorktreeId } from '../../migrating-orcad-catalog/path-rewrite/orcad-migration-path-rewrite'
import { hashWorktreeId } from '../../../pty/history/terminal-history-id'

import { createUncToLinuxPathRewriter } from '../manifest-scope/wsl-move-path-rewriter'
import {
  buildWslMoveShellHistoryBlobs,
  type WslMoveShellHistoryBlobs
} from './wsl-move-shell-history-blobs'

const SOURCE_ID = 'repo-a::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const DESTINATION_ID = rewriteOrcadMigrationWorktreeId(
  SOURCE_ID,
  createUncToLinuxPathRewriter('Ubuntu')
)

let root: string

function writeHistory(worktreeId: string, file: string, content: string | Buffer): string {
  const directory = join(root, hashWorktreeId(worktreeId))
  mkdirSync(directory, { recursive: true })
  const path = join(directory, file)
  writeFileSync(path, content)
  return path
}

function build(
  worktrees = [{ sourceWorktreeId: SOURCE_ID, destinationWorktreeId: DESTINATION_ID }]
): Promise<WslMoveShellHistoryBlobs> {
  return buildWslMoveShellHistoryBlobs({ distro: 'Ubuntu', worktrees, historyRoot: root })
}

describe('WSL move shell history blobs', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-wsl-move-history-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a read once the file changed after its digest was taken', async () => {
    const path = writeHistory(SOURCE_ID, 'bash_history', 'one\n')
    const blobs = await build()
    const [descriptor] = blobs.descriptors
    appendFileSync(path, 'two\n')

    await expect(blobs.source.readChunk(descriptor, 0, 1024)).rejects.toThrow(
      'orcad_migration_source_blob_changed:shell-history'
    )
    await expect(
      blobs.source.readChunk({ ...descriptor, sha256: 'f'.repeat(64) }, 0, 1)
    ).rejects.toThrow('orcad_migration_source_blob_changed:shell-history')
  })
})
