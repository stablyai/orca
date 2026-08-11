import type { DirEntry } from '../../shared/types'
import type { FileReadResult, FileStat, IFilesystemProvider } from '../providers/types'

// Shared by the remote AI Vault scanner suites: an in-memory filesystem whose
// directory tree is derived from the file paths added to it.
export class MemoryRemoteProvider implements IFilesystemProvider {
  private readonly files = new Map<string, { content: string; mtimeMs: number }>()
  private readonly readDirErrors = new Map<string, Error>()
  private readonly statErrors = new Map<string, Error>()
  readonly readDirPaths: string[] = []

  addFile(path: string, content: string, mtimeMs: number): void {
    this.files.set(normalize(path), { content, mtimeMs })
  }

  failStat(path: string, error: Error): void {
    this.statErrors.set(normalize(path), error)
  }

  failReadDir(path: string, error: Error): void {
    this.readDirErrors.set(normalize(path), error)
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    const dir = normalize(dirPath)
    this.readDirPaths.push(dir)
    const readDirError = this.readDirErrors.get(dir)
    if (readDirError) {
      throw readDirError
    }
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
    const statError = this.statErrors.get(normalize(filePath))
    if (statError) {
      throw statError
    }
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
