import { spawnProcess } from '@orca/process-host'
import type { ProviderProcessSpawner } from '../../../provider-process/provider-process-spawn'
import { buildProcessIndex } from '../../../memory/process-index'
import { readWindowsProcessIdentityTableFresh } from '../../../windows/windows-process-table'
import { windowsJobObjectApi, type WindowsJobObjectApi } from '../../../windows/windows-job-object'
import { serverChain } from './codex-shared-lease-process-scan'

/** Set once a shared server's tree could not be held in its job; Windows chats then keep their
 *  own server for the rest of the session, as with the setting off. */
let sharingRefused = false

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
      this.api.assignProcessToJob(this.job, child.pid)
    }
    return child
  }

  /** Throws unless the launcher chain down to native Codex is in the job, and then this
   *  session's later Windows chats keep their own server. Codex that started before assignment,
   *  or an outer job that forbids nesting, leaves it out. */
  async requireHolds(rootPid: number | undefined): Promise<void> {
    if (!(await this.holdsServer(rootPid))) {
      sharingRefused = true
      throw new CodexSharedServerUncontainedError()
    }
  }

  private async holdsServer(rootPid: number | undefined): Promise<boolean> {
    if (rootPid === undefined) {
      return false
    }
    const rows = await this.readTable().catch(() => [])
    const index = buildProcessIndex(
      rows.map((row) => ({ pid: row.pid, ppid: row.ppid, cpu: 0, memory: 0, name: row.name })),
      null,
      'working-set'
    )
    const chain = serverChain(index, rootPid)
    return (
      chain !== null && [...chain].every((pid) => this.api.isProcessInJob(this.job, pid) === true)
    )
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
