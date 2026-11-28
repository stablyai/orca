import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../shared/testing/remove-temp-dirs.test-support'
import type { WindowsProcessEvidence } from '../../daemon/endpoint/identity/daemon-incarnation-evidence-types'
import { pinWslHostLinuxUsers } from '../orcad/wsl-orcad-host-user'
import { buildWslDistroHolderArgs, WSL_DISTRO_HOLDER_MARKER } from './wsl-distro-holder-command'
import { createWslDistroHolder } from './wsl-distro-holder'
import { writeWslDistroHolderRecord } from './wsl-distro-holder-record'
import type { WslDistroHolderChild } from './wsl-distro-holder-types'

const OLD_PID = 4100
const NEW_PID = 4200
const commandLine = (user?: string): string =>
  `"C:\\Windows\\System32\\wsl.exe" ${buildWslDistroHolderArgs('Ubuntu', user).join(' ')} ${WSL_DISTRO_HOLDER_MARKER}`

// #49180: the holder watches its account's ~/.orca, so it must run as the host's pinned account.
describe('WSL distro holder account', () => {
  const dirs: string[] = []
  afterEach(async () => {
    pinWslHostLinuxUsers([])
    await removeTempDirs(dirs.splice(0))
  })

  // First in the file: no records read has happened yet in this module.
  it('keeps a holder until pins load, then replaces one running as another account', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-holder-user-'))
    dirs.push(userDataPath)
    await writeWslDistroHolderRecord(userDataPath, {
      version: 1,
      distro: 'Ubuntu',
      pid: OLD_PID,
      creationTimeMs: 1,
      startedAtMs: 1
    })
    const alive = new Set([OLD_PID])
    const killed: number[] = []
    const holder = createWslDistroHolder({
      userDataPath,
      queryProcess: async (pid): Promise<WindowsProcessEvidence> =>
        alive.has(pid)
          ? {
              status: 'present',
              commandLine: commandLine(pid === OLD_PID ? 'root' : 'alice'),
              startedAtMs: 1
            }
          : { status: 'missing' },
      killProcess: (pid) => {
        killed.push(pid)
        alive.delete(pid)
      },
      spawnHolder: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: NEW_PID,
          unref: () => {},
          kill: () => true
        }) satisfies WslDistroHolderChild
        alive.add(NEW_PID)
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
      listRunningDistros: async () => ['Ubuntu'],
      sleep: async () => {}
    })
    // Pins not loaded yet (an unreadable host store): the root holder is kept, not judged.
    expect(await holder.holderState('Ubuntu')).toBe('live')
    expect(killed).toEqual([])
    pinWslHostLinuxUsers([{ distro: 'Ubuntu', linuxUser: 'alice' }])
    const result = await holder.ensureHeld('Ubuntu')
    expect(killed).toEqual([OLD_PID])
    expect(result).toMatchObject({ outcome: 'spawned', record: { pid: NEW_PID } })
  })

  it('passes the pinned account as -u', () => {
    expect(buildWslDistroHolderArgs('Ubuntu', 'root').slice(0, 4)).toEqual([
      '-d',
      'Ubuntu',
      '-u',
      'root'
    ])
    expect(buildWslDistroHolderArgs('Ubuntu')).not.toContain('-u')
  })
})
