/** Runs the generated POSIX liveness probe through a real `/bin/sh` against real sockets. */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELAY_PID_FILENAME } from '../../shared/relay-artifacts'
import {
  parseRelayVersionDirLiveness,
  relayVersionDirLivenessCommand
} from './relay-version-dir-liveness'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { WINDOWS_RELAY_LIVENESS_JS } from './ssh-remote-commands'

const host = getRemoteHostPlatform('linux-x64')
const posixOnly = process.platform === 'win32' ? describe.skip : describe

function probe(dir: string, nodePath: string | undefined = process.execPath): string {
  return execFileSync('/bin/sh', ['-c', relayVersionDirLivenessCommand(host, dir, { nodePath })], {
    encoding: 'utf8'
  })
}

/** A socket inode left by a SIGKILLed listener: connect is refused. Returns the dead PID. */
function leaveStaleSocket(sockPath: string): number {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      'require("net").createServer().listen(process.argv[1],()=>{' +
        'process.stdout.write(String(process.pid));process.kill(process.pid,"SIGKILL")})',
      sockPath
    ],
    { encoding: 'utf8' }
  )
  return Number.parseInt(child.stdout, 10)
}

posixOnly('relayVersionDirLivenessCommand (real shell)', () => {
  const dirs: string[] = []
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done())))
    )
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function versionDir(): string {
    // Short base: sun_path caps socket paths near 104 bytes on macOS.
    const dir = mkdtempSync(join('/tmp', 'rvl-'))
    dirs.push(dir)
    return dir
  }

  it('is exited for a stale socket whose recorded PID is dead', () => {
    const dir = versionDir()
    const deadPid = leaveStaleSocket(join(dir, 'relay-a.sock'))
    writeFileSync(join(dir, RELAY_PID_FILENAME), `${deadPid}\n`)

    expect(parseRelayVersionDirLiveness(probe(dir))).toBe('exited')
  })

  it('is live for a stale socket whose recorded PID is still running', () => {
    const dir = versionDir()
    leaveStaleSocket(join(dir, 'relay-a.sock'))
    writeFileSync(join(dir, RELAY_PID_FILENAME), `${process.pid}\n`)

    expect(parseRelayVersionDirLiveness(probe(dir))).toBe('live')
  })

  it('keeps the test -S rule for a refused socket without a PID file', () => {
    const dir = versionDir()
    leaveStaleSocket(join(dir, 'relay-a.sock'))

    expect(parseRelayVersionDirLiveness(probe(dir))).toBe('live')
  })

  it('is exited without a PID file only when no socket is left', () => {
    expect(parseRelayVersionDirLiveness(probe(versionDir()))).toBe('exited')
  })

  it('is live when another relay of this build still accepts on its socket', async () => {
    const dir = versionDir()
    const deadPid = leaveStaleSocket(join(dir, 'relay-a.sock'))
    writeFileSync(join(dir, RELAY_PID_FILENAME), `${deadPid}\n`)
    const server = createServer()
    servers.push(server)
    await new Promise<void>((done) => server.listen(join(dir, 'relay-b.sock'), done))

    expect(parseRelayVersionDirLiveness(probe(dir))).toBe('live')
  })

  it('is unverifiable when the connect probe times out', () => {
    const dir = versionDir()
    const deadPid = leaveStaleSocket(join(dir, 'relay-a.sock'))
    writeFileSync(join(dir, RELAY_PID_FILENAME), `${deadPid}\n`)
    // Stands in for node: the connect probe prints `unknown` when its timer fires first.
    const timedOutNode = join(dir, 'node')
    writeFileSync(timedOutNode, '#!/bin/sh\nprintf unknown\n')
    chmodSync(timedOutNode, 0o755)

    expect(parseRelayVersionDirLiveness(probe(dir, timedOutNode))).toBe('unverifiable')
  })

  it('is unverifiable when no Node is available to test a leftover socket', () => {
    const dir = versionDir()
    const deadPid = leaveStaleSocket(join(dir, 'relay-a.sock'))
    writeFileSync(join(dir, RELAY_PID_FILENAME), `${deadPid}\n`)

    expect(parseRelayVersionDirLiveness(probe(dir, ''))).toBe('unverifiable')
  })

  it('is unverifiable for an unreadable PID record', () => {
    const dir = versionDir()
    writeFileSync(join(dir, RELAY_PID_FILENAME), 'not-a-pid\n')

    expect(parseRelayVersionDirLiveness(probe(dir))).toBe('unverifiable')
  })
})

describe('parseRelayVersionDirLiveness', () => {
  it('maps the Windows pipe vocabulary and treats anything else as unverifiable', () => {
    expect(parseRelayVersionDirLiveness('ALIVE')).toBe('live')
    expect(parseRelayVersionDirLiveness('WAITING')).toBe('exited')
    expect(parseRelayVersionDirLiveness('DEAD\n')).toBe('exited')
    expect(parseRelayVersionDirLiveness('')).toBe('unverifiable')
    expect(parseRelayVersionDirLiveness('UNKNOWN')).toBe('unverifiable')
  })
})

/** The Windows probe's JavaScript under the local Node; only the pipe names are Windows-only. */
describe('Windows relay liveness script (design D5 .relay-pid)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function windowsProbe(setup: (dir: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), 'rvl-win-'))
    dirs.push(dir)
    setup(dir)
    return parseRelayVersionDirLiveness(
      execFileSync(process.execPath, ['-e', WINDOWS_RELAY_LIVENESS_JS, dir], { encoding: 'utf8' })
    )
  }

  const deadPid = (): number =>
    Number.parseInt(
      spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
        encoding: 'utf8'
      }).stdout,
      10
    )
  const marker = (dir: string): void =>
    writeFileSync(
      join(dir, '.windows-active-pipe-a'),
      '\\\\.\\pipe\\orca-relay-1234567890abcdef1234'
    )

  it('is live for a running recorded PID without touching any pipe', () => {
    expect(
      windowsProbe((dir) => {
        writeFileSync(join(dir, RELAY_PID_FILENAME), `${process.pid}\n`)
        marker(dir)
      })
    ).toBe('live')
  })

  it('is exited for a dead recorded PID whose pipes all refuse', () => {
    expect(
      windowsProbe((dir) => {
        writeFileSync(join(dir, RELAY_PID_FILENAME), `${deadPid()}\n`)
        marker(dir)
      })
    ).toBe('exited')
  })

  it('is exited for a dead recorded PID that left no pipe marker', () => {
    expect(
      windowsProbe((dir) => writeFileSync(join(dir, RELAY_PID_FILENAME), `${deadPid()}\n`))
    ).toBe('exited')
  })

  it('is unverifiable for an unreadable PID record', () => {
    expect(windowsProbe((dir) => writeFileSync(join(dir, RELAY_PID_FILENAME), 'x\n'))).toBe(
      'unverifiable'
    )
  })

  it('keeps the old rule without a PID file: no marker is never evidence of exit', () => {
    expect(windowsProbe(() => {})).toBe('live')
  })
})
