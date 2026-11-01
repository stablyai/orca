/**
 * A text save too large for one remote request: the client sends it in chunks to a temp in this
 * host's private staging folder, and the commit hands the whole text to the same guarded write a
 * one-request save uses, so the result on disk is identical. Bounded per save, per connection and
 * per host; idle saves and a closed socket's saves are dropped, and host start empties the folder.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import { STAGED_FILE_SAVE_LIMITS } from '../../../shared/staged-file-save'
import { writeLocalTextFileWithDiskPrecondition } from '../../ipc/filesystem/local-disk-write-precondition'
import { inspectProcessLiveness } from '../../daemon/daemon-process-inspection'
import type { ProcessLivenessVerdict } from '../../daemon/daemon-incarnation-evidence-types'

type StagedSave = {
  owner: string
  /** The target as the client named it, authorized again at commit. */
  requestedPath: string
  /** Its authorized real path at begin. */
  targetPath: string
  tempPath: string
  totalBytes: number
  written: number
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

  constructor(private readonly deps: StagedFileSavesDeps) {
    this.limits = deps.limits ?? STAGED_FILE_SAVE_LIMITS
  }

  /** `target.realPath` is `target.requestedPath` authorized now, and local. */
  async begin(
    owner: string,
    target: { requestedPath: string; realPath: string },
    totalBytes: number
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
      requestedPath: target.requestedPath,
      targetPath: target.realPath,
      tempPath,
      totalBytes,
      written: 0,
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
        await mkdir(dir, { recursive: true })
        await writeFile(tempPath, Buffer.alloc(0), { flag: 'wx' })
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
    this.touch(owner, saveId, save)
    return this.queue(save, async () => {
      // In order only: a retried or reordered chunk can't land twice or leave a gap.
      if (offset !== save.written || save.written + bytes.length > save.totalBytes) {
        throw new Error('staged_save_out_of_order')
      }
      await appendFile(save.tempPath, bytes)
      save.written += bytes.length
    })
  }

  /** The target is authorized again now; a different real path (a swapped link) refuses the save. */
  async commit(
    owner: string,
    saveId: string,
    precondition: FileWriteDiskPrecondition | undefined,
    authorize: (requestedPath: string) => Promise<string>
  ): Promise<FileWriteResult> {
    const save = this.require(owner, saveId)
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
        const content = (await readFile(save.tempPath)).toString('utf8')
        // The same write a one-request save makes: same locks, compare, and file kept in place.
        return await writeLocalTextFileWithDiskPrecondition(save.targetPath, content, precondition)
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
