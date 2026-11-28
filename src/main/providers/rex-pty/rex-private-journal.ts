import {
  FileTooLargeError,
  readLocalFileBounded
} from '../../filesystem/local-file-io/local-regular-file-read'
import { constants } from 'node:fs'
import { lstat, mkdir, open, link, unlink, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, isAbsolute } from 'node:path'

const MAX_BYTES = 16 * 1024
const JOURNAL_KEY = /^[a-z0-9-]{1,128}\.json$/

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Small immutable, exclusive records for replay fences. No commands or credentials. */
export class RexPrivateJournal {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) {
      throw new Error('Rex journal path must be absolute')
    }
  }

  private path(name: string): string {
    if (!JOURNAL_KEY.test(name)) {
      throw new Error('Invalid Rex journal key')
    }
    return join(this.directory, name)
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.checkDirectory()
  }

  private async checkDirectory(): Promise<void> {
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) {
      throw new Error('Rex journal directory is not private')
    }
  }

  async directoryExists(): Promise<boolean> {
    try {
      await this.checkDirectory()
      return true
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        return false
      }
      throw error
    }
  }

  async read<T>(name: string, parse: (value: unknown) => T): Promise<T | null> {
    const target = this.path(name)
    if (!(await this.directoryExists())) {
      return null
    }
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    ).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) {
        return null
      }
      throw error
    })
    if (!file) {
      return null
    }
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size > MAX_BYTES
      ) {
        throw new Error('Unsafe Rex journal record')
      }
      const bytes = await readLocalFileBounded(file, MAX_BYTES, info.size).catch(
        (error: unknown) => {
          if (error instanceof FileTooLargeError) {
            throw new Error('Rex journal record too large')
          }
          throw error
        }
      )
      return parse(JSON.parse(bytes.toString()))
    } finally {
      await file.close()
    }
  }

  async publish(name: string, data: unknown): Promise<boolean> {
    await this.ensureDirectory()
    const target = this.path(name)
    const bytes = Buffer.from(JSON.stringify(data))
    if (bytes.length > MAX_BYTES) {
      throw new Error('Rex journal record too large')
    }
    const temporary = join(this.directory, `.${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    let published = false
    try {
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        await link(temporary, target)
        published = true
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) {
          throw error
        }
      }
    } finally {
      await unlink(temporary)
    }
    // Persist the exclusive link and temporary-name removal together. Also sync on
    // EEXIST: a previous publisher may have crashed before its directory sync.
    await this.syncDirectory()
    return published
  }

  private async syncDirectory(): Promise<void> {
    const dir = await open(this.directory, constants.O_RDONLY)
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }

  async remove(...names: [string, ...string[]]): Promise<void> {
    const paths = names.map((name) => this.path(name))
    await this.ensureDirectory()
    const results = await Promise.allSettled(
      paths.map((path) =>
        unlink(path).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT')) {
            throw error
          }
        })
      )
    )
    // All removals in the same directory share one durable sync.
    await this.syncDirectory()
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) {
      throw failure.reason
    }
  }

  async listNames(required = false): Promise<string[]> {
    const names = await this.checkDirectory()
      .then(() => readdir(this.directory))
      .catch((error: unknown) => {
        if (!required && hasCode(error, 'ENOENT')) {
          return []
        }
        throw error
      })
    return names.filter((name) => JOURNAL_KEY.test(name))
  }
}
