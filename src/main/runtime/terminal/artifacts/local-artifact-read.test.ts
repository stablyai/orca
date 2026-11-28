import { describe, expect, it } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
import type { TerminalFileGrant } from './file-grants'
import { terminalArtifactContentBlocks, terminalArtifactContentDigest } from './artifact-integrity'
import { readLocalTerminalArtifactRangeFromHandle } from './local-artifact-read'

const PAGE = 384 * 1024

function fakeHandle(file: { bytes: Buffer }, readSizes: number[]): FileHandle {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the range read only calls stat() and read().
  return {
    stat: async () => ({ isFile: () => true, size: file.bytes.byteLength }),
    read: async (buffer: Buffer, _offset: number, length: number, position: number) => {
      readSizes.push(length)
      const bytesRead = file.bytes.copy(buffer, 0, position, position + length)
      return { bytesRead, buffer }
    }
  } as unknown as FileHandle
}

function pinnedGrant(bytes: Buffer): TerminalFileGrant {
  return {
    id: 'grant-1',
    worktreeId: 'wt-1',
    absolutePath: '/tmp/out.bin',
    provider: 'local',
    expiresAt: Number.MAX_SAFE_INTEGER,
    // Why: null stat identity models a same-size swap that stat cannot see.
    statIdentity: null,
    contentDigest: terminalArtifactContentDigest(bytes),
    contentBlocks: terminalArtifactContentBlocks(bytes)
  }
}

describe('readLocalTerminalArtifactRangeFromHandle', () => {
  it('rejects the first page read after a same-size swap, not just the EOF page', async () => {
    const original = Buffer.alloc(PAGE * 3, 0x01)
    const file = { bytes: original }
    const grant = pinnedGrant(original)
    const read = (offset: number) =>
      readLocalTerminalArtifactRangeFromHandle(fakeHandle(file, []), grant, offset, PAGE)

    await read(0)
    file.bytes = Buffer.alloc(original.byteLength, 0x02)

    await expect(read(PAGE)).rejects.toThrow('terminal_file_grant_stale')
  })

  it('rejects a page when the file size no longer matches the grant', async () => {
    const original = Buffer.alloc(PAGE, 0x03)
    const file = { bytes: Buffer.concat([original, Buffer.from('x')]) }
    await expect(
      readLocalTerminalArtifactRangeFromHandle(fakeHandle(file, []), pinnedGrant(original), 0, PAGE)
    ).rejects.toThrow('terminal_file_grant_stale')
  })
})
