/**
 * One warning, once per session, when command-line recovery has stopped working.
 *
 * The reader has no PEB fallback by design: falling back was a total-defeat
 * vector, because any single anomalous NTSTATUS reinstated address-space reads
 * for the life of the process. The cost of removing it is a cliff -- if
 * `NtQueryInformationProcess(ProcessCommandLineInformation)` is refused, every
 * command line comes back empty and agent identity matching silently degrades
 * to image names, while the addon still loads and still enumerates, so every
 * health check stays green. A cliff nobody can see is the failure mode this
 * area keeps producing, so it gets a signal.
 *
 * The querying process is the unambiguous probe. A process can always open
 * itself with `PROCESS_QUERY_LIMITED_INFORMATION`, so its own command line
 * coming back empty means the query is refused host-wide -- not that some
 * target denied a handle, which is normal for roughly a quarter of the table.
 * That is why this keys on our own row rather than a fraction: no threshold to
 * tune, and no false positive on a hardened box where most processes deny.
 */
type CommandLineRow = { pid: number; commandLine?: string }

let warned = false

export function reportWindowsCommandLineRecoveryHealth(rows: CommandLineRow[]): void {
  if (warned) {
    return
  }
  const self = rows.find((row) => row.pid === process.pid)
  // No self row is a different failure, and the caller's own guard rejects it.
  if (!self || (self.commandLine ?? '') !== '') {
    return
  }
  warned = true
  const recovered = rows.filter((row) => (row.commandLine ?? '') !== '').length
  console.warn(
    '[windows-process-table] command-line recovery is refused on this host: the querying ' +
      'process has no command line of its own, so NtQueryInformationProcess' +
      '(ProcessCommandLineInformation) is failing for every process. Agent identity matching ' +
      'falls back to image names. A hooked ntdll that does not know class 60 is the usual cause.',
    { processes: rows.length, withCommandLine: recovered }
  )
}

/** Test-only: the warning is once per session, so cases must not inherit it. */
export function resetWindowsCommandLineRecoveryHealthForTests(): void {
  warned = false
}
