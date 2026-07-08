import type { DirEntry } from '../../shared/types'
import type { FileReadResult, FileStat, IFilesystemProvider } from '../providers/types'

/**
 * In-memory remote filesystem for remote-session-scanner tests. Records every
 * readFile call (each one models a full SSH body transfer) so parse-cache
 * tests can assert exactly which bodies a rescan re-reads.
 */
export class MemoryRemoteProvider implements IFilesystemProvider {
  private readonly files = new Map<string, { content: string; mtimeMs: number }>()
  readonly readFileCalls: string[] = []

  addFile(path: string, content: string, mtimeMs: number): void {
    this.files.set(normalize(path), { content, mtimeMs })
  }

  clearReadFileCalls(): void {
    this.readFileCalls.length = 0
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
    const normalized = normalize(filePath)
    this.readFileCalls.push(normalized)
    const file = this.files.get(normalized)
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

export function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

export function codexTranscript(args: {
  sessionId: string
  title: string
  cwd: string
  timestamp: string
  threadSource?: string
}): string {
  return jsonLines([
    {
      timestamp: args.timestamp,
      type: 'session_meta',
      payload: {
        id: args.sessionId,
        cwd: args.cwd,
        ...(args.threadSource ? { thread_source: args.threadSource } : {})
      }
    },
    {
      timestamp: args.timestamp.replace(':00.000Z', ':01.000Z'),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: args.title }]
      }
    }
  ])
}
