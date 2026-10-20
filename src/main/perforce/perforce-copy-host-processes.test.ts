import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WindowsProcessRow } from '../windows/windows-process-table'
import { orcaOwnedPids } from './perforce-copy-host-processes'

const DAEMON_DIR = join(tmpdir(), 'orca-user-data', 'daemon')
// Another Orca install (a dev build) keeps its daemon under its own user data folder.
const OTHER_DAEMON_DIR = join(tmpdir(), 'orca-dev-user-data', 'daemon')

function row(pid: number, ppid: number, command: string, creationTimeMs = pid): WindowsProcessRow {
  return { pid, ppid, name: command.split(' ')[0], command, creationTimeMs }
}

describe('orcaOwnedPids', () => {
  it('owns this app’s daemon, main and everything they started', () => {
    const rows = [
      row(100, 1, `Orca.exe daemon-entry.js --token ${join(DAEMON_DIR, 'daemon-v41.token')}`),
      row(101, 100, 'pwsh.exe'),
      row(102, 101, 'claude.exe'),
      row(process.pid, 1, 'Orca.exe .', 0),
      row(200, process.pid, 'Orca.exe parcel-watcher-process-entry.js'),
      row(300, 1, `Orca.exe daemon-entry.js --token ${join(OTHER_DAEMON_DIR, 't')}`),
      row(301, 300, 'cmd.exe'),
      row(400, 1, 'cmd.exe')
    ]
    expect([...orcaOwnedPids(rows, DAEMON_DIR)].sort((a, b) => a - b)).toEqual(
      [100, 101, 102, 200, process.pid].sort((a, b) => a - b)
    )
  })

  it('does not follow a ppid whose process exited and whose pid was reused', () => {
    const rows = [
      row(100, 1, `Orca.exe daemon-entry.js --token ${join(DAEMON_DIR, 't')}`, 5_000),
      // Started before the daemon, so its parent was an earlier process with pid 100.
      row(101, 100, 'cmd.exe', 1_000)
    ]
    expect([...orcaOwnedPids(rows, DAEMON_DIR)]).toEqual([100])
  })
})
