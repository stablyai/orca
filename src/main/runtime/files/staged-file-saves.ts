/**
 * Bytes too large for one remote request: the client sends them in chunks to a temp in this host's
 * private staging folder, so nothing lands in the user's folder before the commit. A text save
 * commits through the same guarded write a one-request save uses; an upload creates a new file and
 * never replaces one. Bounded per save, per connection and per host; idle saves and a closed
 * socket's saves are dropped, and host start empties the folder.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../../shared/file-write/file-write-disk-precondition'
import { restrictWindowsDirectory } from '../../../shared/secure-storage/secure-path-windows-acl'
import { STAGED_FILE_SAVE_LIMITS } from '../../../shared/file-write/staged-file-save'
import { writeLocalTextFileWithDiskPrecondition } from '../../filesystem/local-file-io/local-disk-write-precondition'
import { createLocalFileFromSource } from '../../filesystem/local-file-io/filesystem-create-path'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { inspectProcessLiveness } from '../../daemon/endpoint/identity/daemon-process-inspection'
import type { ProcessLivenessVerdict } from '../../daemon/endpoint/identity/daemon-incarnation-evidence-types'

/** 'save' writes over an existing text file; 'upload' creates a new file from the bytes. */
export type StagedSaveKind = 'save' | 'upload'

type StagedSave = {
  owner: string
  kind: StagedSaveKind
  /** The target as the client named it, authorized again at commit. */
  requestedPath: string
  /** Its authorized real path at begin. */
  targetPath: string
  tempPath: string
  totalBytes: number
  written: number
  appending: boolean
  committing: boolean
  aborting: boolean
  // Every op on a save waits for the one before, so a temp is never removed or read mid-append.
  pending: Promise<void>
  idleTimer: ReturnType<typeof setTimeout>
}

export type StagedFileSavesDeps = {
  /** The profile's private staging folder; null refuses staged saves. */
  stagingDir: () => string | null
  limits?: typeof STAGED_FILE_SAVE_LIMITS
  /** Test seams: this process's id, and whether another owner's process still runs. */
  pid?: number
  ownerLiveness?: (pid: number) => ProcessLivenessVerdict
}

// Each process stages in its own subfolder, so runtimes sharing a profile never touch each other's.
const OWNER_FOLDER = /^[1-9][0-9]*$/

export class StagedFileSaves {
  private readonly saves = new Map<string, StagedSave>()
  private readonly limits: typeof STAGED_FILE_SAVE_LIMITS
  private sweep: Promise<void> | null = null
  private warnedUnrestrictedDir = false

  constructor(private readonly deps: StagedFileSavesDeps) {
    this.limits = deps.limits ?? STAGED_FILE_SAVE_LIMITS
  }

  /** `target.realPath` is `target.requestedPath` authorized now, and local. */
  async begin(
    owner: string,
    target: { requestedPath: string; realPath: string },
    totalBytes: number,
    kind: StagedSaveKind = 'save'
  ): Promise<{ saveId: string }> {
    const dir = this.processDir()
    if (!dir) {
      throw new Error('staged_save_unavailable')
    }
    const { maxBytesPerSave, maxSavesPerConnection, maxBytesPerConnection, maxSavesPerHost } =
      this.limits
    const mine = [...this.saves.values()].filter((save) => save.owner === owner)
    if (
      totalBytes > maxBytesPerSave ||
      mine.length >= maxSavesPerConnection ||
      mine.reduce((sum, save) => sum + save.totalBytes, 0) + totalBytes > maxBytesPerConnection ||
      this.saves.size >= maxSavesPerHost
    ) {
      throw new Error('staged_save_limit')
    }
    const saveId = randomUUID()
    const tempPath = join(dir, `${saveId}.tmp`)
    const save: StagedSave = {
      owner,
      kind,
      requestedPath: target.requestedPath,
      targetPath: target.realPath,
      tempPath,
      totalBytes,
      written: 0,
      appending: false,
      committing: false,
      aborting: false,
      pending: Promise.resolve(),
      idleTimer: this.idleTimer(owner, saveId)
    }
    this.saves.set(saveId, save)
    try {
      await this.queue(save, async () => {
        // Before the first save of this run, so the sweep never takes a temp this run made.
        await this.sweepOrphans()
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await this.restrictProcessDir(dir)
        // Created owner-only: the umask can only remove bits from 0o600, and wx keeps the create exclusive.
        await writeFile(tempPath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
      })
      // Abort owns the temp and the reservation until its removal finishes.
      if (save.aborting) {
        throw new Error('staged_save_unknown')
      }
    } catch (error) {
      if (!save.aborting) {
        await rm(tempPath, { force: true }).catch(() => {})
        this.release(saveId, save)
      }
      throw error
    }
    return { saveId }
  }

  async append(owner: string, saveId: string, offset: number, bytes: Buffer): Promise<void> {
    const save = this.require(owner, saveId)
    // Commit has queued the delete. A later chunk would recreate the temp with nothing left to remove it.
    if (save.committing) {
      throw new Error('staged_save_commit_in_progress')
    }
    // Clients send a chunk after the last one lands; one still in flight means this one is out of
    // order, and queuing it would hold its bytes in memory with no bound.
    if (save.appending) {
      throw new Error('staged_save_out_of_order')
    }
    save.appending = true
    this.touch(owner, saveId, save)
    return this.queue(save, async () => {
      // In order only: a retried or reordered chunk can't land twice or leave a gap.
      if (offset !== save.written || save.written + bytes.length > save.totalBytes) {
        throw new Error('staged_save_out_of_order')
      }
      await appendFile(save.tempPath, bytes)
      save.written += bytes.length
    }).finally(() => {
      save.appending = false
    })
  }

  /** The target is authorized again now; a different real path (a swapped link) refuses the save. */
  commit(
    owner: string,
    saveId: string,
    precondition: FileWriteDiskPrecondition | undefined,
    authorize: (requestedPath: string) => Promise<string>
  ): Promise<FileWriteResult> {
    return this.finish(owner, saveId, 'save', authorize, async (save) => {
      const content = (await readFile(save.tempPath)).toString('utf8')
      // The same write a one-request save makes: same locks, compare, and file kept in place.
      return writeLocalTextFileWithDiskPrecondition(save.targetPath, content, precondition)
    })
  }

  /**
   * Creates the target from the staged bytes; a name taken since begin refuses the upload. Once
   * committing, a closed socket lets the copy finish.
   */
  async commitUpload(
    owner: string,
    saveId: string,
    authorize: (requestedPath: string) => Promise<string>
  ): Promise<void> {
    await this.finish(owner, saveId, 'upload', authorize, (save) =>
      createLocalFileFromSource(save.tempPath, windowsFsPath(save.targetPath))
    )
  }

  private async finish<TResult>(
    owner: string,
    saveId: string,
    kind: StagedSaveKind,
    authorize: (requestedPath: string) => Promise<string>,
    write: (save: StagedSave) => Promise<TResult>
  ): Promise<TResult> {
    const save = this.require(owner, saveId)
    // A text save must never commit as a create, nor an upload overwrite as a text save.
    if (save.kind !== kind) {
      throw new Error('staged_save_unknown')
    }
    if (save.committing) {
      throw new Error('staged_save_commit_in_progress')
    }
    save.committing = true
    clearTimeout(save.idleTimer)
    return this.queue(save, async () => {
      try {
        // The file itself, not the count: a temp cut short outside this process can't be saved.
        if (
          save.written !== save.totalBytes ||
          (await stat(save.tempPath)).size !== save.totalBytes
        ) {
          throw new Error('staged_save_incomplete')
        }
        if ((await authorize(save.requestedPath)) !== save.targetPath) {
          throw new Error('staged_save_target_moved')
        }
        return await write(save)
      } finally {
        try {
          await rm(save.tempPath, { force: true })
        } finally {
          this.release(saveId, save)
        }
      }
    })
  }

  /** The temp goes once any append in flight settles. */
  async abort(owner: string, saveId: string): Promise<void> {
    const save = this.saves.get(saveId)
    if (!save || save.owner !== owner) {
      return
    }
    // Commit releases this save after the guarded write. Dropping it now frees capacity early.
    if (save.committing) {
      return
    }
    // Setup may still be creating the temp. Keep the reservation until that file is gone.
    if (save.aborting) {
      await save.pending
      return
    }
    save.aborting = true
    clearTimeout(save.idleTimer)
    await this.queue(save, async () => {
      try {
        await rm(save.tempPath, { force: true })
      } finally {
        this.release(saveId, save)
      }
    }).catch(() => {})
  }

  /** A closed socket can't finish its saves. */
  async abortConnection(owner: string): Promise<void> {
    const ids = [...this.saves].filter(([, save]) => save.owner === owner).map(([id]) => id)
    await Promise.all(ids.map((id) => this.abort(owner, id)))
  }

  /**
   * Host start: this process's folder and those of owners that have exited hold only unfinished
   * saves. A live owner's folder, or one whose owner can't be checked, is left alone.
   */
  sweepOrphans(): Promise<void> {
    this.sweep ??= (async () => {
      const root = this.deps.stagingDir()
      if (!root) {
        return
      }
      const own = String(this.deps.pid ?? process.pid)
      const liveness = this.deps.ownerLiveness ?? inspectProcessLiveness
      try {
        for (const name of await readdir(root).catch(() => [])) {
          if (
            OWNER_FOLDER.test(name) &&
            (name === own || liveness(Number(name)).status === 'exited')
          ) {
            await rm(join(root, name), { recursive: true, force: true })
          }
        }
      } catch (error) {
        console.warn('[files] Could not clear staged saves:', error)
      }
    })()
    return this.sweep
  }

  private processDir(): string | null {
    const root = this.deps.stagingDir()
    return root ? join(root, String(this.deps.pid ?? process.pid)) : null
  }

  /** Best effort: network, FAT and some WSL mounts ignore modes/ACLs, and saves must still work there. */
  private async restrictProcessDir(dir: string): Promise<void> {
    // POSIX chmod also tightens a folder an older build created with default modes.
    const restricted =
      process.platform === 'win32'
        ? await restrictWindowsDirectory(dir)
        : await chmod(dir, 0o700)
            .then(async () => ((await stat(dir)).mode & 0o777) === 0o700)
            .catch(() => false)
    if (!restricted && !this.warnedUnrestrictedDir) {
      this.warnedUnrestrictedDir = true
      console.warn('[files] Could not restrict the staged-saves folder to its owner:', dir)
    }
  }

  private queue<TResult>(save: StagedSave, op: () => Promise<TResult>): Promise<TResult> {
    const run = save.pending.then(op)
    save.pending = run.then(
      () => {},
      () => {}
    )
    return run
  }

  private require(owner: string, saveId: string): StagedSave {
    const save = this.saves.get(saveId)
    // Another connection's id reads as unknown, so ids can't be probed across clients.
    if (!save || save.owner !== owner || save.aborting) {
      throw new Error('staged_save_unknown')
    }
    return save
  }

  private release(saveId: string, save: StagedSave): void {
    clearTimeout(save.idleTimer)
    this.saves.delete(saveId)
  }

  private touch(owner: string, saveId: string, save: StagedSave): void {
    clearTimeout(save.idleTimer)
    save.idleTimer = this.idleTimer(owner, saveId)
  }

  private idleTimer(owner: string, saveId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => void this.abort(owner, saveId), this.limits.idleMs)
    timer.unref?.()
    return timer
  }
}
