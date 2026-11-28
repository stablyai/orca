// Run the liveness probe in /bin/sh against PID and readiness markers that name no process (#51014).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { ORCAD_PID_FILENAME, ORCAD_READINESS_FILENAME } from './orcad-remote-host-support'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'

const host = getRemoteHostPlatform('linux-x64')
let root = ''
let versionDir = ''
const children: ChildProcess[] = []
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

function probe(prefix = ''): string {
  const command = `${prefix} ${orcadLivenessProbeCommand(host, versionDir)}`
  return parseOrcadLiveness(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }))
}

function writeMarkers(pid: string): void {
  writeFileSync(join(versionDir, ORCAD_PID_FILENAME), pid)
  writeFileSync(join(versionDir, ORCAD_READINESS_FILENAME), '')
}

function runSlotEntry(entry: string): void {
  children.push(
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', join(versionDir, entry)], {
      stdio: 'ignore'
    })
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-markers-'))
  versionDir = join(root, '.orca-remote', 'orcad-0.1.0+old')
  mkdirSync(versionDir, { recursive: true })
})

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
  rmSync(root, { recursive: true, force: true })
})

describeOnPosix('liveness of a slot whose markers name no PID', () => {
  it.each([
    ['zero-byte', ''],
    ['non-numeric', 'garbage']
  ])('is DEAD with a %s PID file when nothing runs the slot', (_kind, pid) => {
    writeMarkers(pid)
    expect(probe()).toBe('DEAD')
  })

  it('is DEAD with only a zero-byte readiness file left', () => {
    writeFileSync(join(versionDir, ORCAD_READINESS_FILENAME), '')
    expect(probe()).toBe('DEAD')
  })

  it.each(['orcad.js', 'orcad-server.js'])(
    'stays UNKNOWN while a process still runs the slot %s',
    (entry) => {
      writeMarkers('')
      runSlotEntry(entry)
      expect(probe()).toBe('UNKNOWN')
    }
  )

  it('is not kept UNKNOWN by a process running another slot', () => {
    writeMarkers('')
    children.push(
      spawn(
        process.execPath,
        [
          '-e',
          'setTimeout(() => {}, 30000)',
          join(root, '.orca-remote', 'orcad-0.1.0+new', 'orcad.js')
        ],
        { stdio: 'ignore' }
      )
    )
    expect(probe()).toBe('DEAD')
  })

  // Without /proc the probe lists processes with ps; if that fails too it cannot prove the slot stopped.
  it.runIf(!existsSync('/proc/self/cmdline'))(
    'stays UNKNOWN when processes cannot be listed',
    () => {
      writeMarkers('')
      expect(probe('ps() { return 127; };')).toBe('UNKNOWN')
    }
  )
})
