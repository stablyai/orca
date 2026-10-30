/** Warn once when our own command line is empty: self permits a limited query handle, while other processes may deny one. No PEB fallback may restore address-space reads after a refused kernel query. */
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

/** Reset the once-per-session warning between tests. */
export function resetWindowsCommandLineRecoveryHealthForTests(): void {
  warned = false
}
