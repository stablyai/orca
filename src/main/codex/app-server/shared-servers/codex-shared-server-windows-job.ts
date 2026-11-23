import { spawnProcess } from '@orca/process-host'
import type { spawnCodexAppServerConnection } from '../codex-app-server-connection'
import type { ProviderProcessSpawner } from '../../../provider-process/provider-process-spawn'
import { readWindowsProcessIdentityTableFresh } from '../../../windows/windows-process-table'
import { windowsJobObjectApi, type WindowsJobObjectApi } from '../../../windows/windows-job-object'
import { childrenByParent, descendants } from './codex-shared-host-process-reading'

/** Set once a shared server's tree could not be held in its job; Windows chats then keep their
 *  own server for the rest of the session, as with the setting off. */
let sharingRefused = false
/** When a check last found no native Codex to judge. One may be a crash; a second within this
 *  window turns sharing off. */
let lastInconclusiveAt: number | null = null
const INCONCLUSIVE_WINDOW_MS = 10 * 60_000

/** A shared Windows server whose tree isn't in its job; its chat falls back to its own server. */
export class CodexSharedServerUncontainedError extends Error {
  constructor() {
    super('codex shared app-server could not be held in its Windows job')
  }
}

/** Whether Windows chats may share a server: the addon has the job exports and no server has
 *  failed to be held in one. */
export function windowsSharedServersAvailable(): boolean {
  return !sharingRefused && windowsJobObjectApi() !== null
}

/** One kill-on-close job per shared Windows server. Job membership survives a parent's exit, so a
 *  process a finished command left running stays a member and the server's close ends it. Children
 *  of a packaged (Microsoft Store) shell leave every job, so those it can't reach. */
export class CodexSharedServerWindowsJob {
  private ended = false

  private constructor(
    private readonly api: WindowsJobObjectApi,
    private readonly job: unknown,
    private readonly readTable: typeof readWindowsProcessIdentityTableFresh
  ) {}

  static create(
    api: WindowsJobObjectApi | null = windowsJobObjectApi(),
    readTable = readWindowsProcessIdentityTableFresh
  ): CodexSharedServerWindowsJob | null {
    const job = api?.createKillOnCloseJob() ?? null
    return api && job !== null ? new CodexSharedServerWindowsJob(api, job, readTable) : null
  }

  /** Assigns the launcher the moment it exists, before it can start Codex; a launcher that wins
   *  that race is caught by holdsServer. */
  readonly spawn: ProviderProcessSpawner = (spec) => {
    const child = spawnProcess(spec)
    if (child.pid !== undefined) {
      // Same tick as the spawn: libuv holds the child's handle until the loop reaps its exit, so
      // Windows can't have reused this pid yet.
      this.api.assignProcessToJob(this.job, child.pid)
    }
    return child
  }

  /** Opens the server with its launcher in this job, and ends the job after every close of it. */
  connect(connect: typeof spawnCodexAppServerConnection): typeof spawnCodexAppServerConnection {
    return async (launch, handlers) => {
      const connection = await connect(launch, handlers, this.spawn).catch((error: unknown) => {
        this.terminate()
        throw error
      })
      // The tree kill misses what a finished command left running; the job doesn't.
      const close = connection.close.bind(connection)
      connection.close = () => close().finally(() => this.terminate())
      return connection
    }
  }

  /** Throws unless the launcher chain down to native Codex is in the job. A chain member outside
   *  it (Codex that started before assignment, or an outer job that forbids nesting) makes this
   *  session's later Windows chats keep their own server. A server that exited meanwhile proves
   *  nothing about containment; its chats already saw the exit, so it fails as an exit. */
  async requireHolds(rootPid: number | undefined, exited: () => boolean): Promise<void> {
    const verdict = await this.holdsServer(rootPid)
    if (verdict === 'held') {
      return
    }
    if (exited()) {
      throw new Error('codex shared app-server exited before it took chats')
    }
    // Native Codex crashing before its launcher's exit is seen looks like no chain at all.
    const now = Date.now()
    const repeated = lastInconclusiveAt !== null && now - lastInconclusiveAt < INCONCLUSIVE_WINDOW_MS
    if (verdict === 'inconclusive') {
      lastInconclusiveAt = now
    }
    if (verdict === 'outside' || (verdict === 'inconclusive' && repeated)) {
      sharingRefused = true
    }
    throw new CodexSharedServerUncontainedError()
  }

  private async holdsServer(
    rootPid: number | undefined
  ): Promise<'held' | 'outside' | 'inconclusive'> {
    if (rootPid === undefined) {
      return 'inconclusive'
    }
    const rows = await this.readTable().catch(() => [])
    const byPid = new Map(rows.map((row) => [row.pid, row] as const))
    const children = childrenByParent(rows.map((row) => [row.pid, row.ppid] as const))
    // Windows keeps a dead parent's pid: a child older than its "parent" belongs to an earlier one.
    const ownChild = (child: number, parent: number): boolean => {
      const childBorn = byPid.get(child)?.creationTimeMs
      const parentBorn = byPid.get(parent)?.creationTimeMs
      return childBorn === undefined || parentBorn === undefined || childBorn >= parentBorn
    }
    // The whole tree, not just the path to Codex: a launcher's other children count too.
    const tree = [rootPid, ...descendants(children, rootPid, ownChild)]
    if (!tree.some((pid) => /^codex/i.test(byPid.get(pid)?.name ?? ''))) {
      return 'inconclusive'
    }
    const members = tree.map((pid) => this.api.isProcessInJob(this.job, pid))
    if (members.includes(false)) {
      return 'outside'
    }
    return members.every((member) => member === true) ? 'held' : 'inconclusive'
  }

  /** Ends every process still in the job, orphans included, and closes it. */
  terminate(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    try {
      this.api.terminateJob(this.job)
    } catch {
      // Already closed.
    }
  }
}
