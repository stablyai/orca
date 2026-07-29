import { describe, expect, it } from 'vitest'
import { access, truncate, writeFile } from 'node:fs/promises'
import type { DirEntry } from '../../shared/types'
import type { FileReadResult, FileStat, IFilesystemProvider } from '../providers/types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import {
  MAX_REMOTE_SESSION_DOWNLOAD_BYTES,
  REMOTE_SESSION_IN_MEMORY_LIMIT_BYTES
} from './remote-session-scanner-large-file'

type RemoteFile = {
  content: string
  mtimeMs: number
  reportedSizeBytes: number
  downloadedSizeBytes?: number
}

class LargeRemoteProvider implements IFilesystemProvider {
  private readonly files = new Map<string, RemoteFile>()
  readonly readFilePaths: string[] = []
  readonly downloads: { sourcePath: string; destinationPath: string }[] = []
  maxConcurrentDownloads = 0
  private activeDownloads = 0

  addFile(
    path: string,
    content: string,
    mtimeMs: number,
    reportedSizeBytes = content.length,
    downloadedSizeBytes?: number
  ): void {
    this.files.set(normalize(path), {
      content,
      mtimeMs,
      reportedSizeBytes,
      downloadedSizeBytes
    })
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    const dir = normalize(dirPath)
    const prefix = `${dir}/`
    const entries = new Map<string, DirEntry>()
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) {
        continue
      }
      const [name, ...rest] = path.slice(prefix.length).split('/')
      if (name) {
        entries.set(name, { name, isDirectory: rest.length > 0, isSymlink: false })
      }
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  async readFile(filePath: string): Promise<FileReadResult> {
    const path = normalize(filePath)
    this.readFilePaths.push(path)
    const file = this.files.get(path)
    if (!file) {
      throw new Error(`ENOENT: ${filePath}`)
    }
    return { content: file.content, isBinary: false }
  }

  async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
    const file = this.files.get(normalize(sourcePath))
    if (!file) {
      throw new Error(`ENOENT: ${sourcePath}`)
    }
    this.downloads.push({ sourcePath: normalize(sourcePath), destinationPath })
    this.activeDownloads++
    this.maxConcurrentDownloads = Math.max(this.maxConcurrentDownloads, this.activeDownloads)
    try {
      await new Promise((resolve) => setImmediate(resolve))
      await writeFile(destinationPath, file.content, { flag: 'wx' })
      if (file.downloadedSizeBytes !== undefined) {
        await truncate(destinationPath, file.downloadedSizeBytes)
      }
    } finally {
      this.activeDownloads--
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const file = this.files.get(normalize(filePath))
    if (!file) {
      throw new Error(`ENOENT: ${filePath}`)
    }
    return {
      size: file.reportedSizeBytes,
      type: 'file',
      mtime: file.mtimeMs,
      mtimeMs: file.mtimeMs
    }
  }

  writeFile = unsupported
  writeFileBase64 = unsupported
  writeFileBase64Chunk = unsupported
  deletePath = unsupported
  createFile = unsupported
  createDir = unsupported
  createDirNoClobber = unsupported
  rename = unsupported
  renameNoClobber = unsupported
  copy = unsupported
  realpath = async (path: string): Promise<string> => path
  search = unsupported
  listFiles = unsupported
  watch = unsupported
}

describe('large remote session scanning', () => {
  it('downloads and line-parses large transcripts one at a time', async () => {
    const provider = new LargeRemoteProvider()
    provider.addFile(
      '/home/ada/.codex/session_index.jsonl',
      jsonLines([
        { id: 'large-a', thread_name: 'Indexed large A' },
        { id: 'large-b', thread_name: 'Indexed large B' }
      ]),
      40
    )
    provider.addFile(
      '/home/ada/.claude/projects/repo/large-claude.jsonl',
      claudeTranscript(),
      30,
      REMOTE_SESSION_IN_MEMORY_LIMIT_BYTES + 1
    )
    provider.addFile(
      '/home/ada/.codex/sessions/large-a.jsonl',
      codexTranscript('large-a', '2026-07-04T02:00:00.000Z'),
      20,
      REMOTE_SESSION_IN_MEMORY_LIMIT_BYTES + 1
    )
    provider.addFile(
      '/home/ada/.codex/sessions/large-b.jsonl',
      codexTranscript('large-b', '2026-07-04T01:00:00.000Z'),
      10,
      REMOTE_SESSION_IN_MEMORY_LIMIT_BYTES + 1
    )

    const result = await scan(provider)

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      'large-claude',
      'large-a',
      'large-b'
    ])
    expect(result.sessions.map((session) => session.title)).toEqual([
      'Large Claude',
      'Indexed large A',
      'Indexed large B'
    ])
    expect(provider.downloads.map(({ sourcePath }) => sourcePath)).toEqual([
      '/home/ada/.claude/projects/repo/large-claude.jsonl',
      '/home/ada/.codex/sessions/large-a.jsonl',
      '/home/ada/.codex/sessions/large-b.jsonl'
    ])
    expect(provider.maxConcurrentDownloads).toBe(1)
    expect(
      provider.readFilePaths.filter(
        (path) => path.includes('/sessions/') || path.includes('/projects/')
      )
    ).toEqual([])
    for (const { destinationPath } of provider.downloads) {
      await expect(access(destinationPath)).rejects.toThrow()
    }
  })

  it('rejects a transcript above the bounded download limit', async () => {
    const provider = new LargeRemoteProvider()
    provider.addFile(
      '/home/ada/.codex/sessions/oversized.jsonl',
      codexTranscript('oversized', '2026-07-04T01:00:00.000Z'),
      10,
      MAX_REMOTE_SESSION_DOWNLOAD_BYTES + 1
    )

    const result = await scan(provider)

    expect(result.sessions).toEqual([])
    expect(result.issues[0]?.message).toContain('exceeds 256MB limit')
    expect(provider.downloads).toEqual([])
  })

  it('removes a downloaded transcript that grew beyond the bounded limit', async () => {
    const provider = new LargeRemoteProvider()
    provider.addFile(
      '/home/ada/.codex/sessions/grown.jsonl',
      codexTranscript('grown', '2026-07-04T01:00:00.000Z'),
      10,
      REMOTE_SESSION_IN_MEMORY_LIMIT_BYTES + 1,
      MAX_REMOTE_SESSION_DOWNLOAD_BYTES + 1
    )

    const result = await scan(provider)

    expect(result.sessions).toEqual([])
    expect(result.issues[0]?.message).toContain('exceeds 256MB limit')
    expect(provider.downloads).toHaveLength(1)
    await expect(access(provider.downloads[0].destinationPath)).rejects.toThrow()
  })
})

function scan(provider: IFilesystemProvider) {
  return scanRemoteAiVaultSessions({
    provider,
    executionHostId: 'ssh:dev-box',
    remoteHome: '/home/ada',
    hostPlatform: getRemoteHostPlatform('linux-x64')
  })
}

function codexTranscript(sessionId: string, timestamp: string): string {
  return jsonLines([
    {
      timestamp,
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/home/ada/repo' }
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: `Prompt ${sessionId}` }]
      }
    }
  ])
}

function claudeTranscript(): string {
  return jsonLines([
    {
      sessionId: 'large-claude',
      timestamp: '2026-07-04T03:00:00.000Z',
      type: 'user',
      message: { content: [{ type: 'text', text: 'Large Claude' }] }
    },
    {
      sessionId: 'large-claude',
      timestamp: '2026-07-04T03:00:01.000Z',
      type: 'assistant',
      message: { model: 'claude-opus-4', content: 'Done' }
    }
  ])
}

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function unsupported(): Promise<never> {
  throw new Error('unsupported')
}
