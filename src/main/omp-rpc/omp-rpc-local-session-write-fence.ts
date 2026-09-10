import { basename, isAbsolute, resolve, win32 } from 'node:path'

export class OmpRpcLocalSessionWriteFence {
  private readonly writersBySessionPath = new Map<string, string>()
  private readonly pendingWritersBySessionPath = new Map<string, string>()
  private readonly knownSessionPathsById = new Map<string, string>()

  reserve(sessionFilePath: string, owner: string): boolean {
    const canonicalPath = this.canonicalSessionPath(sessionFilePath)
    const current = this.writersBySessionPath.get(canonicalPath)
    if (current && current !== owner) {
      return false
    }
    this.writersBySessionPath.set(canonicalPath, owner)
    const sessionId = this.sessionIdFromPath(canonicalPath)
    if (sessionId) {
      this.knownSessionPathsById.set(sessionId, canonicalPath)
    }
    return true
  }

  release(sessionFilePath: string, owner: string): void {
    const canonicalPath = this.canonicalSessionPath(sessionFilePath)
    if (this.writersBySessionPath.get(canonicalPath) === owner) {
      const pending = this.pendingWritersBySessionPath.get(canonicalPath)
      if (pending) {
        this.writersBySessionPath.set(canonicalPath, pending)
        this.pendingWritersBySessionPath.delete(canonicalPath)
      } else {
        this.writersBySessionPath.delete(canonicalPath)
      }
    } else if (this.pendingWritersBySessionPath.get(canonicalPath) === owner) {
      this.pendingWritersBySessionPath.delete(canonicalPath)
    }
  }

  move(fromSessionFilePath: string, toSessionFilePath: string, owner: string): boolean {
    const fromPath = this.canonicalSessionPath(fromSessionFilePath)
    const toPath = this.canonicalSessionPath(toSessionFilePath)
    const current = this.writersBySessionPath.get(toPath)
    if (current && current !== owner) {
      return false
    }
    if (this.writersBySessionPath.get(fromPath) !== owner) {
      return false
    }
    this.writersBySessionPath.delete(fromPath)
    this.writersBySessionPath.set(toPath, owner)
    const sessionId = this.sessionIdFromPath(toPath)
    if (sessionId) {
      this.knownSessionPathsById.set(sessionId, toPath)
    }
    return true
  }

  /** Preserves an RPC fence behind an active PTY writer during conflict retirement. */
  reserveAfterCurrentWriter(sessionFilePath: string, owner: string): boolean {
    const canonicalPath = this.canonicalSessionPath(sessionFilePath)
    if (this.reserve(canonicalPath, owner)) {
      return true
    }
    const pending = this.pendingWritersBySessionPath.get(canonicalPath)
    if (pending && pending !== owner) {
      return false
    }
    this.pendingWritersBySessionPath.set(canonicalPath, owner)
    return true
  }

  assertPtySpawnAllowed(command: string | undefined, cwd: string): void {
    const sessionFilePath = this.resumeSessionFilePath(command, cwd)
    if (!sessionFilePath) {
      return
    }
    if (this.writersBySessionPath.has(this.canonicalSessionPath(sessionFilePath))) {
      throw new Error('agent_session_conflict')
    }
  }

  reservePtySpawn(command: string | undefined, cwd: string, owner: string): string | null {
    const sessionFilePath = this.resumeSessionFilePath(command, cwd)
    if (!sessionFilePath) {
      return null
    }
    if (!this.reserve(sessionFilePath, owner)) {
      throw new Error('agent_session_conflict')
    }
    return sessionFilePath
  }

  private resumeSessionFilePath(command: string | undefined, _cwd: string): string | null {
    const match = /(?:^|[;&|]\s*|\s)["']?--resume["']?(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i.exec(
      command ?? ''
    )
    const resumeTarget = match?.[1] ?? match?.[2] ?? match?.[3]
    if (!resumeTarget) {
      return null
    }
    if (isAbsolute(resumeTarget) || this.isWindowsSessionPath(resumeTarget)) {
      return this.canonicalSessionPath(
        this.isWindowsSessionPath(resumeTarget)
          ? win32.resolve(resumeTarget)
          : resolve(resumeTarget)
      )
    }
    return this.knownSessionPathsById.get(resumeTarget) ?? null
  }

  private canonicalSessionPath(sessionFilePath: string): string {
    return this.isWindowsSessionPath(sessionFilePath)
      ? win32.normalize(sessionFilePath).toLocaleLowerCase('en-US')
      : resolve(sessionFilePath)
  }

  private isWindowsSessionPath(sessionFilePath: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(sessionFilePath) || sessionFilePath.startsWith('\\\\')
  }

  private sessionIdFromPath(sessionFilePath: string): string | null {
    const filename = basename(sessionFilePath)
    const stem = filename.endsWith('.jsonl') ? filename.slice(0, -'.jsonl'.length) : filename
    const separator = stem.indexOf('_')
    return separator === -1 || separator === stem.length - 1 ? null : stem.slice(separator + 1)
  }
}

export const localOmpRpcSessionWriteFence = new OmpRpcLocalSessionWriteFence()
