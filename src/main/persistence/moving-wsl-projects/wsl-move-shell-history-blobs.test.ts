import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseOrcadMigrationBlobDescriptor,
  type OrcadMigrationBlobDescriptor
} from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { rewriteOrcadMigrationWorktreeId } from '../../ssh/orcad-migration-path-rewrite'
import { hashWorktreeId } from '../../terminal-history-id'
import { parseOrcadMigrationShellHistoryHeader } from '../migrating-orcad-catalog/orcad-migration-shell-history-format'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import {
  buildWslMoveShellHistoryBlobs,
  type WslMoveShellHistoryBlobs
} from './wsl-move-shell-history-blobs'

const SOURCE_ID = 'repo-a::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const DESTINATION_ID = rewriteOrcadMigrationWorktreeId(
  SOURCE_ID,
  createUncToLinuxPathRewriter('Ubuntu')
)
const SOURCE_FOLDER_ID = 'folder:workspace-1'

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

async function readAll(
  blobs: WslMoveShellHistoryBlobs,
  descriptor: OrcadMigrationBlobDescriptor,
  chunk: number
): Promise<Buffer> {
  const parts: Buffer[] = []
  for (let offset = 0; offset < descriptor.byteLength; offset += chunk) {
    parts.push(await blobs.source.readChunk(descriptor, offset, chunk))
  }
  return Buffer.concat(parts)
}

describe('WSL move shell history blobs', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-wsl-move-history-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keys each zsh/bash history by the host worktree id and carries that id in the header', async () => {
    expect(DESTINATION_ID).toBe('repo-a::/home/dev/app')
    writeHistory(SOURCE_ID, 'zsh_history', ': 1700000000:0;ls\n')
    writeHistory(SOURCE_ID, 'bash_history', 'git status\n')

    const blobs = await build()

    const keys = blobs.descriptors.map((descriptor) => descriptor.key)
    const hash = hashWorktreeId(DESTINATION_ID)
    expect(keys).toEqual([`${hash}-zsh`, `${hash}-bash`])
    expect(keys.some((key) => key.startsWith(hashWorktreeId(SOURCE_ID)))).toBe(false)
    for (const descriptor of blobs.descriptors) {
      expect(parseOrcadMigrationBlobDescriptor(descriptor)).toEqual(descriptor)
      // Read in pieces that straddle the header boundary.
      const bytes = await readAll(blobs, descriptor, 7)
      expect(bytes.length).toBe(descriptor.byteLength)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(descriptor.sha256)
      const header = parseOrcadMigrationShellHistoryHeader(descriptor.key, bytes, bytes.length)
      expect(header.worktreeId).toBe(DESTINATION_ID)
    }
    const zsh = await readAll(blobs, blobs.descriptors[0], 1024)
    expect(zsh.toString('utf8')).toBe(
      `{"version":1,"worktreeId":"repo-a::/home/dev/app"}\n: 1700000000:0;ls\n`
    )
  })

  it('marks a bash history as the login shell only when no zsh history came with it', async () => {
    writeHistory(SOURCE_ID, 'zsh_history', ': 1:0;ls\n')
    writeHistory(SOURCE_ID, 'bash_history', 'ls\n')
    writeHistory(SOURCE_FOLDER_ID, 'bash_history', 'make\n')

    const blobs = await build([
      { sourceWorktreeId: SOURCE_ID, destinationWorktreeId: DESTINATION_ID },
      { sourceWorktreeId: SOURCE_FOLDER_ID, destinationWorktreeId: SOURCE_FOLDER_ID }
    ])

    const loginShell = await Promise.all(
      blobs.descriptors.map(async (descriptor) => {
        const bytes = await readAll(blobs, descriptor, descriptor.byteLength)
        return parseOrcadMigrationShellHistoryHeader(descriptor.key, bytes, bytes.length).loginShell
      })
    )
    expect(loginShell).toEqual([false, false, true])
  })

  it('skips missing and empty files and never sends fish', async () => {
    writeHistory(SOURCE_ID, 'zsh_history', '')
    writeHistory(SOURCE_ID, 'fish_history', '- cmd: ls\n')
    writeHistory(SOURCE_FOLDER_ID, 'bash_history', 'make\n')

    const blobs = await build([
      { sourceWorktreeId: SOURCE_ID, destinationWorktreeId: DESTINATION_ID },
      { sourceWorktreeId: SOURCE_FOLDER_ID, destinationWorktreeId: SOURCE_FOLDER_ID },
      { sourceWorktreeId: 'repo-a::/never-opened', destinationWorktreeId: 'repo-a::/never-opened' }
    ])

    expect(blobs.descriptors.map((descriptor) => descriptor.key)).toEqual([
      `${hashWorktreeId(SOURCE_FOLDER_ID)}-bash`
    ])
  })

  it('blocks the move on a history over the per-blob cap instead of truncating it', async () => {
    const path = writeHistory(SOURCE_ID, 'bash_history', '')
    truncateSync(path, 64 * 1024 * 1024)

    await expect(build()).rejects.toThrow(
      `orcad_migration_shell_history_too_large:${hashWorktreeId(DESTINATION_ID)}-bash`
    )
  })

  it('merges the \\\\wsl$ and \\\\wsl.localhost histories of one worktree oldest first', async () => {
    const legacyId = SOURCE_ID.replace('wsl.localhost', 'wsl$')
    const legacy = writeHistory(legacyId, 'bash_history', 'old one\nold two')
    const current = writeHistory(SOURCE_ID, 'bash_history', 'new one\n')
    utimesSync(legacy, 1_000, 1_000)
    utimesSync(current, 2_000, 2_000)

    // Input order must not outrank history age.
    const blobs = await build([
      { sourceWorktreeId: SOURCE_ID, destinationWorktreeId: DESTINATION_ID },
      { sourceWorktreeId: legacyId, destinationWorktreeId: DESTINATION_ID }
    ])

    expect(blobs.descriptors.map((descriptor) => descriptor.key)).toEqual([
      `${hashWorktreeId(DESTINATION_ID)}-bash`
    ])
    const [descriptor] = blobs.descriptors
    const bytes = await readAll(blobs, descriptor, 5)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(descriptor.sha256)
    const header = parseOrcadMigrationShellHistoryHeader(descriptor.key, bytes, bytes.length)
    expect(bytes.subarray(header.byteLength).toString('utf8')).toBe('old one\nold two\nnew one\n')
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
