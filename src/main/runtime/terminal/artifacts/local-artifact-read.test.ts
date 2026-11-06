import { describe, expect, it } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
import type { TerminalFileGrant } from './file-grants'
import { terminalArtifactContentDigest } from './artifact-integrity'
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
    expiresAt: Date.now() + 60_000,
    // Why: null stat identity models a same-size swap that stat cannot see.
    statIdentity: null,
    contentDigest: terminalArtifactContentDigest(bytes)
  }
}

async function download(
  grant: TerminalFileGrant,
  file: { bytes: Buffer },
  readSizes: number[],
  beforePage?: (offset: number) => void
): Promise<Buffer> {
  const pages: Buffer[] = []
  for (let offset = 0, eof = false; !eof;) {
    beforePage?.(offset)
    const page = await readLocalTerminalArtifactRangeFromHandle(
      fakeHandle(file, readSizes),
      grant,
      offset,
      PAGE
    )
    pages.push(Buffer.from(page.contentBase64, 'base64'))
    offset += page.bytesRead
    eof = page.eof
  }
  return Buffer.concat(pages)
}

describe('readLocalTerminalArtifactRangeFromHandle', () => {
  it('reads each page of a digest-pinned file once instead of re-reading the whole file', async () => {
    const file = { bytes: Buffer.alloc(PAGE * 3 + 17, 0x5a) }
    const readSizes: number[] = []

    const result = await download(pinnedGrant(file.bytes), file, readSizes)

    expect(result.equals(file.bytes)).toBe(true)
    expect(readSizes.reduce((sum, size) => sum + size, 0)).toBe(file.bytes.byteLength)
  })

  it('rejects the EOF page when a same-size swap lands between pages', async () => {
    const original = Buffer.alloc(PAGE * 2 + 1, 0x01)
    const file = { bytes: original }
    const grant = pinnedGrant(original)

    await expect(
      download(grant, file, [], (offset) => {
        if (offset > 0) {
          file.bytes = Buffer.alloc(original.byteLength, 0x02)
        }
      })
    ).rejects.toThrow('terminal_file_grant_stale')
  })

  it('still serves out-of-order pages by verifying the whole file', async () => {
    const file = { bytes: Buffer.alloc(PAGE * 2, 0x07) }
    const page = await readLocalTerminalArtifactRangeFromHandle(
      fakeHandle(file, []),
      pinnedGrant(file.bytes),
      PAGE,
      PAGE
    )
    expect(page.bytesRead).toBe(PAGE)
    expect(page.eof).toBe(true)
  })
})
