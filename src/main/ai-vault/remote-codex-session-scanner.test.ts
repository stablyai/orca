import { describe, expect, it } from 'vitest'
import type { DirEntry } from '../../shared/types'
import type { FileReadResult, FileStat, IFilesystemProvider } from '../providers/types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteCodexSessions } from './remote-codex-session-scanner'

class MemoryRemoteProvider implements IFilesystemProvider {
  private readonly files = new Map<string, { content: string; mtimeMs: number }>()

  addFile(path: string, content: string, mtimeMs: number): void {
    this.files.set(normalize(path), { content, mtimeMs })
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    const dir = normalize(dirPath)
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const entries = new Map<string, DirEntry>()
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) {
        continue
      }
      const relative = path.slice(prefix.length)
      if (!relative) {
        continue
      }
      const [name, ...rest] = relative.split('/')
      if (!name) {
        continue
      }
      entries.set(name, {
        name,
        isDirectory: rest.length > 0,
        isSymlink: false
      })
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  async readFile(filePath: string): Promise<FileReadResult> {
    const file = this.files.get(normalize(filePath))
    if (!file) {
      throw new Error(`ENOENT: ${filePath}`)
    }
    return { content: file.content, isBinary: false }
  }

  async stat(filePath: string): Promise<FileStat> {
    const file = this.files.get(normalize(filePath))
    if (!file) {
      throw new Error(`ENOENT: ${filePath}`)
    }
    return { size: file.content.length, type: 'file', mtime: file.mtimeMs, mtimeMs: file.mtimeMs }
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

async function unsupported(): Promise<never> {
  throw new Error('unsupported')
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('scanRemoteCodexSessions', () => {
  it('parses remote default and Orca-managed Codex homes with SSH host ids', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      '/home/ada/.codex/session_index.jsonl',
      jsonLines([{ id: 'default-session', thread_name: 'Indexed remote title' }]),
      1
    )
    provider.addFile(
      '/home/ada/.codex/sessions/2026/07/04/default.jsonl',
      jsonLines([
        {
          timestamp: '2026-07-04T01:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'default-session', cwd: '/home/ada/repo' }
        },
        {
          timestamp: '2026-07-04T01:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Fallback default title' }]
          }
        }
      ]),
      10
    )
    provider.addFile(
      '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/runtime.jsonl',
      jsonLines([
        {
          timestamp: '2026-07-04T02:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'runtime-session', cwd: '/home/ada/runtime-repo' }
        },
        {
          timestamp: '2026-07-04T02:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Managed remote title' }]
          }
        }
      ]),
      20
    )

    const result = await scanRemoteCodexSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title)).toEqual([
      'Managed remote title',
      'Indexed remote title'
    ])
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(2)
    expect(result.sessions.every((session) => session.executionHostId === 'ssh:dev-box')).toBe(true)
    expect(
      result.sessions.find((session) => session.sessionId === 'default-session')
    ).toMatchObject({
      codexHome: '/home/ada/.codex',
      resumeCommand:
        "cd '/home/ada/repo' && CODEX_HOME='/home/ada/.codex' codex resume 'default-session'"
    })
    expect(
      result.sessions.find((session) => session.sessionId === 'runtime-session')
    ).toMatchObject({
      codexHome: '/home/ada/.local/share/orca/codex-runtime-home/home',
      resumeCommand:
        "cd '/home/ada/runtime-repo' && CODEX_HOME='/home/ada/.local/share/orca/codex-runtime-home/home' codex resume 'runtime-session'"
    })
  })

  it('builds resume commands with the remote host platform', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      'C:/Users/Ada/.codex/sessions/win.jsonl',
      jsonLines([
        {
          timestamp: '2026-07-04T03:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'win-session', cwd: 'C:/repo/app' }
        },
        {
          timestamp: '2026-07-04T03:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Windows remote title' }]
          }
        }
      ]),
      30
    )

    const result = await scanRemoteCodexSessions({
      provider,
      executionHostId: 'ssh:win-box',
      remoteHome: 'C:/Users/Ada',
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions[0]?.resumeCommand).toBe(
      'cmd /d /s /c "cd /d ""C:/repo/app"" && set ""CODEX_HOME=C:/Users/Ada/.codex"" && codex resume ""win-session"""'
    )
  })
})
