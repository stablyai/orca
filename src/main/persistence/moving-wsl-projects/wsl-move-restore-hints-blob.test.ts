import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseOrcadMigrationBlobDescriptor } from '../../../shared/orcad-migration-blob-transfer'
import { parseOrcadMigrationTerminalRestoreHintsText } from '../../../shared/orcad-migration-terminal-restore-hints'
import { buildWslMoveRestoreHintsBlob } from './wsl-move-restore-hints-blob'

const hints = [
  { paneKey: 'tab-1:11111111-1111-4111-8111-111111111111', cwd: '/home/me/src' },
  { paneKey: 'tab-2:22222222-2222-4222-8222-222222222222', cwd: '/srv/app' }
]

describe('WSL move restore hints blob', () => {
  it('sends no blob when quiesce found no hints', () => {
    expect(buildWslMoveRestoreHintsBlob([])).toBeNull()
  })

  it('encodes a descriptor the channel accepts over bytes the destination parses back', async () => {
    const blob = buildWslMoveRestoreHintsBlob(hints)
    expect(blob).not.toBeNull()
    if (!blob) {
      return
    }
    expect(parseOrcadMigrationBlobDescriptor(blob.descriptor)).toEqual({
      blobKind: 'terminal-restore-hints',
      key: 'migration',
      sha256: createHash('sha256').update(blob.bytes).digest('hex'),
      byteLength: blob.bytes.length
    })
    expect(parseOrcadMigrationTerminalRestoreHintsText(blob.bytes.toString('utf8'))).toEqual({
      version: 1,
      hints
    })
    const head = await blob.source.readChunk(blob.descriptor, 0, 5)
    const rest = await blob.source.readChunk(blob.descriptor, 5, blob.bytes.length)
    expect(Buffer.concat([head, rest])).toEqual(blob.bytes)
    await expect(
      blob.source.readChunk({ ...blob.descriptor, byteLength: 1 }, 0, 1)
    ).rejects.toThrow('orcad_migration_source_blob_changed:terminal-restore-hints')
  })

  it('refuses a hint the destination would refuse, and an oversize document', () => {
    expect(() => buildWslMoveRestoreHintsBlob([{ paneKey: 'tab-1:1', cwd: '/home' }])).toThrow(
      'orcad_migration_terminal_restore_hint_pane_key_invalid'
    )
    const many = Array.from({ length: 1100 }, (_, index) => ({
      paneKey: `tab-${index}:11111111-1111-4111-8111-111111111111`,
      cwd: `/${'a'.repeat(4000)}`
    }))
    expect(() => buildWslMoveRestoreHintsBlob(many)).toThrow(
      'orcad_migration_terminal_restore_hints_too_large'
    )
  })
})
