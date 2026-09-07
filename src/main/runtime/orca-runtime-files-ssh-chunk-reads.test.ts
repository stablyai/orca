import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  enoent,
  openMock,
  resolveAuthorizedPathMock,
  statMock
} from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { FileRangeReadUnsupportedError } from '../providers/types'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import { BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES } from '../../shared/browser-client-file-channel-protocol'
import type { RuntimeFileCommands } from './orca-runtime-files'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/rg-availability',
  async () => (await import('./orca-runtime-files-mock-registry')).rgAvailabilityMock
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock(
  '../ipc/filesystem-search-git',
  async () => (await import('./orca-runtime-files-mock-registry')).filesystemSearchGitMock
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

/**
 * LCG bytes, whose period is far past any fixture here. An index-derived pattern repeats on a
 * power-of-two stride that divides the chunk and window sizes, which makes a re-read of the wrong
 * window compare equal to the right one.
 */
function remoteFileBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  let state = 0x2f6e2b1
  for (let index = 0; index < size; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

function sshCommands() {
  return createRuntimeFileCommands({
    path: '/remote/repo',
    resolveRuntimeFileTarget: vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
      executionHostId: 'ssh:ssh-1'
    }))
  }).commands
}

function installSshFile(
  contents: Buffer,
  overrides?: { readFileRange?: unknown; stat?: unknown }
): { readFileRange: ReturnType<typeof vi.fn>; stat: ReturnType<typeof vi.fn> } {
  const readFileRange = vi.fn(async (_filePath: string, position: number, length: number) => {
    const bytes = contents.subarray(position, position + length)
    return { bytes, bytesRead: bytes.byteLength }
  })
  const stat = vi.fn(async () => ({ size: contents.byteLength, type: 'file' as const, mtime: 0 }))
  const provider = {
    stat: overrides?.stat ?? stat,
    ...(overrides && 'readFileRange' in overrides
      ? { readFileRange: overrides.readFileRange }
      : { readFileRange })
  }
  vi.mocked(getSshFilesystemProvider).mockReturnValue(provider as never)
  return { readFileRange, stat }
}

/** Mirrors the `browser.upload` staging loop in browser-client-upload-transfer. */
async function drainUploadChunks(
  commands: RuntimeFileCommands,
  relativePath: string
): Promise<Buffer> {
  const parts: Buffer[] = []
  let offset = 0
  for (let iterations = 0; ; iterations += 1) {
    expect(iterations).toBeLessThan(64)
    const chunk = await commands.readFileExplorerChunk(
      'id:wt-1',
      relativePath,
      offset,
      BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES
    )
    const payload = Buffer.from(chunk.contentBase64, 'base64')
    // The real loop rejects a chunk whose count disagrees with its payload before staging it.
    expect(payload.byteLength).toBe(chunk.bytesRead)
    parts.push(payload)
    offset += chunk.bytesRead
    if (chunk.eof) {
      return Buffer.concat(parts)
    }
    expect(chunk.bytesRead).toBeGreaterThan(0)
  }
}

/** Digest compare: a failed `toEqual` on a few-hundred-KB Buffer spends minutes rendering a diff. */
function expectSameBytes(actual: Buffer, expected: Buffer): void {
  const digest = (bytes: Buffer) => ({
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  })
  expect(digest(actual)).toEqual(digest(expected))
}

/** The clamp and the cap together promise every request lands inside the statted file. */
function expectRequestsWithinFile(readFileRange: ReturnType<typeof vi.fn>, fileSize: number): void {
  expect(readFileRange.mock.calls.length).toBeGreaterThan(0)
  for (const [, position, length] of readFileRange.mock.calls) {
    expect(length).toBeLessThanOrEqual(MAX_FILE_RANGE_READ_BYTES)
    expect(position + length).toBeLessThanOrEqual(fileSize)
  }
}

// A size that is not a multiple of either the chunk or the window, so a page served from the wrong
// offset cannot land on an identical-looking boundary.
const REMOTE_FILE_BYTES = BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES * 3 + 4321
// files.readChunk window the renderer's remote download loop uses (REMOTE_DOWNLOAD_CHUNK_BYTES).
const REMOTE_DOWNLOAD_WINDOW_BYTES = 384 * 1024

describe('RuntimeFileCommands.readFileExplorerChunk over SSH', () => {
  useRuntimeFileCommandsLifecycle()

  it('reassembles a multi-chunk SSH-workspace file byte-identically', async () => {
    const contents = remoteFileBytes(REMOTE_FILE_BYTES)
    const { readFileRange } = installSshFile(contents)

    expectSameBytes(await drainUploadChunks(sshCommands(), 'docs/report.pdf'), contents)
    expect(readFileRange).toHaveBeenCalledWith(
      '/remote/repo/docs/report.pdf',
      0,
      expect.any(Number)
    )
    expectRequestsWithinFile(readFileRange, contents.byteLength)
  })

  it('ends on the chunk boundary when the file size is an exact chunk multiple', async () => {
    const contents = remoteFileBytes(BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES * 2)
    installSshFile(contents)
    const commands = sshCommands()

    const first = await commands.readFileExplorerChunk(
      'id:wt-1',
      'archive.zip',
      0,
      BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES
    )
    const second = await commands.readFileExplorerChunk(
      'id:wt-1',
      'archive.zip',
      BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES,
      BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES
    )

    expect(first.eof).toBe(false)
    expect(second.bytesRead).toBe(BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES)
    expect(second.eof).toBe(true)
    expectSameBytes(
      Buffer.concat([
        Buffer.from(first.contentBase64, 'base64'),
        Buffer.from(second.contentBase64, 'base64')
      ]),
      contents
    )
  })

  it('pages a window wider than the host range cap instead of asking for an over-cap read', async () => {
    const contents = remoteFileBytes(REMOTE_FILE_BYTES)
    const { readFileRange } = installSshFile(contents)

    const chunk = await sshCommands().readFileExplorerChunk(
      'id:wt-1',
      'big.bin',
      0,
      REMOTE_FILE_BYTES
    )

    expectSameBytes(Buffer.from(chunk.contentBase64, 'base64'), contents)
    expect(chunk.bytesRead).toBe(REMOTE_FILE_BYTES)
    expect(chunk.eof).toBe(true)
    expect(readFileRange.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [0, MAX_FILE_RANGE_READ_BYTES],
      [MAX_FILE_RANGE_READ_BYTES, REMOTE_FILE_BYTES - MAX_FILE_RANGE_READ_BYTES]
    ])
  })

  // The upload chunk (128 KiB) never pages; the renderer's 384 KiB download window is the caller
  // that does, and it reaches SSH worktrees only because this seam stopped throwing.
  it('pages the renderer download window into one capped read and one remainder', async () => {
    const contents = remoteFileBytes(REMOTE_FILE_BYTES)
    const { readFileRange } = installSshFile(contents)

    const chunk = await sshCommands().readFileExplorerChunk(
      'id:wt-1',
      'big.bin',
      0,
      REMOTE_DOWNLOAD_WINDOW_BYTES
    )

    expectSameBytes(
      Buffer.from(chunk.contentBase64, 'base64'),
      contents.subarray(0, REMOTE_DOWNLOAD_WINDOW_BYTES)
    )
    expect(chunk.eof).toBe(false)
    expect(readFileRange.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [0, MAX_FILE_RANGE_READ_BYTES],
      [MAX_FILE_RANGE_READ_BYTES, REMOTE_DOWNLOAD_WINDOW_BYTES - MAX_FILE_RANGE_READ_BYTES]
    ])
  })

  it('clamps a window that overshoots EOF instead of requesting past the file', async () => {
    const contents = remoteFileBytes(MAX_FILE_RANGE_READ_BYTES + 4321)
    const { readFileRange } = installSshFile(contents)

    const chunk = await sshCommands().readFileExplorerChunk(
      'id:wt-1',
      'big.bin',
      0,
      REMOTE_DOWNLOAD_WINDOW_BYTES
    )

    expectSameBytes(Buffer.from(chunk.contentBase64, 'base64'), contents)
    expect(chunk.eof).toBe(true)
    expectRequestsWithinFile(readFileRange, contents.byteLength)
  })

  it('never reads past the requested window', async () => {
    const contents = remoteFileBytes(4096)
    installSshFile(contents)

    const chunk = await sshCommands().readFileExplorerChunk('id:wt-1', 'small.bin', 1000, 500)

    expect(chunk.bytesRead).toBe(500)
    expect(Buffer.from(chunk.contentBase64, 'base64')).toEqual(contents.subarray(1000, 1500))
    expect(chunk.eof).toBe(false)
  })

  // Not a stall guarantee: the caller's next chunk re-stats the now-smaller file and ends the
  // transfer short, exactly as the local branch does. Only the single chunk's flag is pinned here.
  it('stops on a window the host could not fill and reports it against the stale size', async () => {
    const contents = remoteFileBytes(4096)
    installSshFile(contents, {
      readFileRange: vi.fn(async () => ({ bytes: contents.subarray(0, 10), bytesRead: 10 }))
    })

    const chunk = await sshCommands().readFileExplorerChunk('id:wt-1', 'short.bin', 0, 4096)

    expect(chunk.bytesRead).toBe(10)
    expect(chunk.eof).toBe(false)
  })

  it('fails loudly when the SSH host cannot serve ranged reads', async () => {
    installSshFile(remoteFileBytes(4096), {
      readFileRange: vi.fn(async () => {
        throw new FileRangeReadUnsupportedError()
      })
    })

    await expect(
      sshCommands().readFileExplorerChunk('id:wt-1', 'docs/report.pdf', 0, 1024)
    ).rejects.toThrow('ranged file reads')
  })

  it('fails loudly when the SSH provider has no ranged-read method at all', async () => {
    installSshFile(remoteFileBytes(4096), { readFileRange: undefined })

    await expect(
      sshCommands().readFileExplorerChunk('id:wt-1', 'docs/report.pdf', 0, 1024)
    ).rejects.toThrow('ranged file reads')
  })

  it('fails loudly when the remote file is missing', async () => {
    const { readFileRange } = installSshFile(remoteFileBytes(4096), {
      stat: vi.fn(async () => {
        throw enoent()
      })
    })

    await expect(
      sshCommands().readFileExplorerChunk('id:wt-1', 'docs/missing.pdf', 0, 1024)
    ).rejects.toThrow('ENOENT')
    expect(readFileRange).not.toHaveBeenCalled()
  })

  it('refuses a remote directory before reading', async () => {
    const { readFileRange } = installSshFile(remoteFileBytes(0), {
      stat: vi.fn(async () => ({ size: 0, type: 'directory' as const, mtime: 0 }))
    })

    await expect(sshCommands().readFileExplorerChunk('id:wt-1', 'docs', 0, 1024)).rejects.toThrow(
      'Cannot download a directory'
    )
    expect(readFileRange).not.toHaveBeenCalled()
  })

  it('still serves a non-SSH worktree from the local file handle', async () => {
    const contents = remoteFileBytes(2048)
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockResolvedValue('/repo/local.bin')
    statMock.mockResolvedValue({ isDirectory: () => false, size: contents.byteLength })
    const close = vi.fn(async () => undefined)
    openMock.mockResolvedValue({
      read: vi.fn(
        async (buffer: Buffer, bufferOffset: number, length: number, position: number) => {
          const bytesRead = contents.copy(buffer, bufferOffset, position, position + length)
          return { bytesRead }
        }
      ),
      close
    })

    const chunk = await commands.readFileExplorerChunk('id:wt-1', 'local.bin', 0, 1024)

    expect(Buffer.from(chunk.contentBase64, 'base64')).toEqual(contents.subarray(0, 1024))
    expect(chunk.eof).toBe(false)
    expect(close).toHaveBeenCalled()
    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
  })
})
