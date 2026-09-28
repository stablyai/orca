import {
  getPosixPtyStoppedJobGroups,
  signalPosixPtyProcessGroups
} from '../../pty/posix-pty-process-groups'

export function createBunPtyProcessSuspension(options: {
  pid: number
  platform: NodeJS.Platform
  signalRoot: (signal: 'SIGSTOP' | 'SIGCONT') => void
  readProcessTable?: () => string
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
}) {
  const stoppedGroups = new Set<number>()
  return {
    hasStoppedGroups: () => stoppedGroups.size > 0,
    signal(signal: 'SIGSTOP' | 'SIGCONT', table?: string, requireGroups = false): void {
      const alreadyStopped =
        signal === 'SIGSTOP' && table !== undefined
          ? getPosixPtyStoppedJobGroups(table, options.pid)
          : new Set<number>()
      let resumeFailed = false
      signalPosixPtyProcessGroups(
        options.pid,
        signal,
        () => {
          if (requireGroups) {
            throw new Error('Paused PTY group ownership is unavailable')
          }
          options.signalRoot(signal)
        },
        {
          platform: options.platform,
          ...(table !== undefined
            ? { readProcessTable: () => table }
            : options.readProcessTable
              ? { readProcessTable: options.readProcessTable }
              : {}),
          signalProcessGroup(pgid) {
            if (
              signal === 'SIGSTOP'
                ? alreadyStopped.has(pgid) && !stoppedGroups.has(pgid)
                : !stoppedGroups.has(pgid)
            ) {
              return
            }
            // Keep the shell stopped until every preceding job group has resumed.
            if (signal === 'SIGCONT' && requireGroups && resumeFailed) {
              throw new Error('An earlier PTY group could not be resumed')
            }
            try {
              if (options.signalProcessGroup) {
                options.signalProcessGroup(pgid, signal)
              } else {
                process.kill(-pgid, signal)
              }
            } catch (error) {
              const gone = error instanceof Error && 'code' in error && error.code === 'ESRCH'
              if (gone) {
                stoppedGroups.delete(pgid)
              }
              resumeFailed = !gone
              throw error
            }
            if (signal === 'SIGSTOP') {
              stoppedGroups.add(pgid)
            } else {
              stoppedGroups.delete(pgid)
            }
          }
        }
      )
      if (signal === 'SIGCONT') {
        // A fresh successful scan also retires groups that no longer belong to this terminal.
        stoppedGroups.clear()
      }
    }
  }
}
