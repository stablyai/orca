import { describe, expect, it } from 'vitest'
import {
  residencyOfGeneration,
  scanResidentExecutables,
  type ProcReader
} from './appimage-generation-residency'

const ROOT = '/home/u/.cache/orca/appimage/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb'

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function proc(processes: Record<string, { uid: number; exe: string | Error }>): ProcReader {
  return {
    listPids: () => Object.keys(processes),
    ownerUid: (pid) => processes[pid]!.uid,
    readExe: (pid) => {
      const exe = processes[pid]!.exe
      if (exe instanceof Error) {
        throw exe
      }
      return exe
    }
  }
}

function residency(processes: Record<string, { uid: number; exe: string | Error }>) {
  return residencyOfGeneration(
    scanResidentExecutables({ proc: proc(processes), uid: 1000, platform: 'linux' }),
    ROOT
  )
}

describe('AppImage generation residency', () => {
  it('is live while a same-user process runs from the generation', () => {
    expect(residency({ '1': { uid: 1000, exe: `${ROOT}/orca-ide` } })).toEqual({ status: 'live' })
    expect(residency({ '1': { uid: 1000, exe: `${ROOT}/orca-ide (deleted)` } })).toEqual({
      status: 'live'
    })
  })

  it('is exited when only other users or other paths run', () => {
    expect(
      residency({
        '1': { uid: 0, exe: `${ROOT}/orca-ide` },
        '2': { uid: 1000, exe: `${ROOT}-other/orca-ide` },
        '3': { uid: 1000, exe: errorWithCode('ENOENT') }
      })
    ).toEqual({ status: 'exited' })
  })

  it('skips non-dumpable processes it may not read', () => {
    expect(
      residency({
        '1': { uid: 1000, exe: errorWithCode('EACCES') },
        '2': { uid: 1000, exe: errorWithCode('EPERM') }
      })
    ).toEqual({ status: 'exited' })
  })

  it('is unverifiable when a same-user process or /proc cannot be read', () => {
    expect(residency({ '1': { uid: 1000, exe: errorWithCode('EIO') } })).toMatchObject({
      status: 'unverifiable'
    })
    const unreadable: ProcReader = {
      listPids: () => {
        throw errorWithCode('EACCES')
      },
      ownerUid: () => 0,
      readExe: () => ''
    }
    expect(
      residencyOfGeneration(
        scanResidentExecutables({ proc: unreadable, uid: 1000, platform: 'linux' }),
        ROOT
      )
    ).toMatchObject({ status: 'unverifiable' })
  })

  it('reports nothing resident off Linux', () => {
    expect(residencyOfGeneration(scanResidentExecutables({ platform: 'darwin' }), ROOT)).toEqual({
      status: 'exited'
    })
  })
})

describe.runIf(process.platform === 'linux')('AppImage generation residency on this host', () => {
  it('reads every same-user process, including this one', () => {
    const scan = scanResidentExecutables()
    expect(scan).toMatchObject({ status: 'scanned', unreadablePid: null })
    expect(scan.status === 'scanned' && scan.executables.length).toBeGreaterThan(0)
  })
})
