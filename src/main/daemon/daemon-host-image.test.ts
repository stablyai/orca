import { describe, expect, it } from 'vitest'
import { inspectDaemonHostImage, type DaemonHostImageProc } from './daemon-host-image'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'

const PID = 4288
const STAT = `${PID} (orca-ide) S 1 4288 4288 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0`
const BOOT = 'boot-1'
const OLD_MOUNT = '/tmp/.mount_orcaAb12'
const OWN_MOUNT = '/tmp/.mount_orcaZz99'

function fuseLine(point: string): string {
  return `1 2 0:50 / ${point} ro,nosuid,nodev relatime - fuse.orca-linux.AppImage orca-linux.AppImage ro`
}

function record(overrides: Partial<ParsedDaemonPid> = {}): ParsedDaemonPid {
  return {
    pid: PID,
    startedAtMs: null,
    entryPath: `${OLD_MOUNT}/resources/app.asar.unpacked/out/main/daemon-entry.js`,
    appVersion: '1.4.212',
    launchNonce: 'nonce',
    linuxStartTicks: '777',
    bootId: BOOT,
    spawnerExecPath: `${OLD_MOUNT}/orca-ide`,
    cgroupUnit: null,
    ...overrides
  }
}

function proc(options: {
  exe: string | Error
  mountinfo?: string
  existing?: string[]
  stat?: string
}): DaemonHostImageProc {
  return {
    readlink: (path) => {
      expect(path).toBe(`/proc/${PID}/exe`)
      if (options.exe instanceof Error) {
        throw options.exe
      }
      return options.exe
    },
    readFile: (path) => {
      if (path === `/proc/${PID}/stat`) {
        return options.stat ?? STAT
      }
      if (path === '/proc/sys/kernel/random/boot_id') {
        return `${BOOT}\n`
      }
      if (path === `/proc/${PID}/mountinfo`) {
        return options.mountinfo ?? ''
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    exists: (path) => (options.existing ?? []).includes(path)
  }
}

function verdict(r: ParsedDaemonPid | null, p: DaemonHostImageProc) {
  return inspectDaemonHostImage(r, { proc: p, platform: 'linux' }).verdict
}

describe('inspectDaemonHostImage', () => {
  it('leaves a daemon on the extracted copy alone after the window that started it unmounts', () => {
    const node = '/home/me/.cache/orca/appimage/aaa/bbb/resources/node-runtime/bin/node'
    const copyDaemon = record({
      entryPath: '/apps/Orca.AppImage/resources/app.asar.unpacked/out/main/daemon-entry.js'
    })
    expect(verdict(copyDaemon, proc({ exe: node, existing: [`/proc/${PID}/root${node}`] }))).toBe(
      'not-ephemeral'
    )
  })

  it('is intact while the daemon mount is still in its mount table', () => {
    expect(
      verdict(record(), proc({ exe: `${OLD_MOUNT}/orca-ide`, mountinfo: fuseLine(OLD_MOUNT) }))
    ).toBe('intact')
  })

  it('is intact for an own-mount daemon recorded with the window mount as its spawner', () => {
    expect(
      verdict(record(), proc({ exe: `${OWN_MOUNT}/orca-ide`, mountinfo: fuseLine(OWN_MOUNT) }))
    ).toBe('intact')
  })

  it('is severed once the mount is gone from the daemon mount table', () => {
    expect(verdict(record(), proc({ exe: `${OLD_MOUNT}/orca-ide`, mountinfo: '' }))).toBe('severed')
  })

  it('is severed when a lazy unmount leaves a path relative to the detached root', () => {
    // #18200: readlink /proc/<pid>/exe printed "/orca-ide" after the mount went away.
    expect(verdict(record(), proc({ exe: '/orca-ide' }))).toBe('severed')
  })

  it('is severed when the runtime extract dir was deleted', () => {
    const extracted = '/tmp/appimage_extracted_0123abcd/orca-ide'
    const r = record({ spawnerExecPath: extracted, entryPath: null })
    expect(verdict(r, proc({ exe: `${extracted} (deleted)` }))).toBe('severed')
    expect(verdict(r, proc({ exe: extracted, existing: [`/proc/${PID}/root${extracted}`] }))).toBe(
      'intact'
    )
  })

  it('leaves deb, rpm and extracted-cache daemons alone', () => {
    const installed = record({
      spawnerExecPath: '/opt/Orca/orca-ide',
      entryPath: '/opt/Orca/resources/app.asar.unpacked/out/main/daemon-entry.js'
    })
    expect(verdict(installed, proc({ exe: '/opt/Orca/orca-ide' }))).toBe('not-ephemeral')
    // An in-place package upgrade is not an ephemeral image; stale-bundle policy owns it.
    expect(verdict(installed, proc({ exe: '/opt/Orca/orca-ide (deleted)' }))).toBe('not-ephemeral')
  })

  it('says nothing when the pid is not the recorded incarnation or cannot be read', () => {
    const recycled = `${PID} (bash) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0`
    expect(verdict(record(), proc({ exe: '/orca-ide', stat: recycled }))).toBe('unknown')
    expect(
      verdict(record(), proc({ exe: Object.assign(new Error('EACCES'), { code: 'EACCES' }) }))
    ).toBe('unknown')
    expect(verdict(record({ linuxStartTicks: null }), proc({ exe: '/orca-ide' }))).toBe('unknown')
    expect(verdict(null, proc({ exe: '/orca-ide' }))).toBe('unknown')
  })

  it('never reports severance off Linux', () => {
    expect(
      inspectDaemonHostImage(record(), { proc: proc({ exe: '/orca-ide' }), platform: 'darwin' })
        .verdict
    ).toBe('not-ephemeral')
  })
})
