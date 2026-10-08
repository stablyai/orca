import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  ORCAD_LOG_FILENAME,
  ORCAD_PID_FILENAME,
  ORCAD_READINESS_FILENAME,
  orcadLaunchCommand
} from './orcad-remote-launch'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// The readiness file carries the pairing offer's device token: under a login umask of 022 it must
// still come out owner-only, and so must the slot and `~/.orca-remote` that hold it.

const posix = getRemoteHostPlatform('linux-x64')
const READY_LINE = '{"type":"orca_server_ready","pairing":{"url":"orca://pair#token"}}'

let home: string
let baseDir: string
let slotDir: string

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

async function launchUnderLoginUmask(): Promise<void> {
  const command = orcadLaunchCommand(posix, {
    remoteInstallDir: slotDir,
    // No runtime marker in the slot, so this legacy path runs the stub entry below.
    nodePath: '/bin/sh',
    fullVersion: '0.2.0+bb01',
    userDataDir: join(home, '.orca'),
    bindHost: '127.0.0.1',
    port: 7777,
    activationRoot: join(baseDir, '.orcad-activation-transaction')
  })
  await runProcess({ program: '/bin/sh', args: ['-c', `umask 022; ${command}`], timeoutMs: 10_000 })
  const readiness = join(slotDir, ORCAD_READINESS_FILENAME)
  const deadline = Date.now() + 5_000
  while (!readFileSync(readiness, 'utf8').includes(READY_LINE) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe.skipIf(process.platform === 'win32')('orcad launch file modes', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orcad-launch-modes-'))
    baseDir = join(home, '.orca-remote')
    slotDir = join(baseDir, 'orcad-0.2.0+bb01')
    mkdirSync(slotDir, { recursive: true, mode: 0o755 })
    chmodSync(baseDir, 0o755)
    chmodSync(slotDir, 0o755)
    writeFileSync(join(slotDir, 'orcad.js'), `printf '%s\\n' '${READY_LINE}'\n`)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('creates the readiness, pid and log files owner-only', async () => {
    await launchUnderLoginUmask()

    expect(readFileSync(join(slotDir, ORCAD_READINESS_FILENAME), 'utf8')).toContain(READY_LINE)
    expect(mode(join(slotDir, ORCAD_READINESS_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, ORCAD_PID_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, ORCAD_LOG_FILENAME))).toBe(0o600)
  })

  it('tightens files and directories an earlier build left readable', async () => {
    for (const name of [ORCAD_READINESS_FILENAME, ORCAD_PID_FILENAME, ORCAD_LOG_FILENAME]) {
      writeFileSync(join(slotDir, name), 'old', { mode: 0o644 })
      chmodSync(join(slotDir, name), 0o644)
    }

    await launchUnderLoginUmask()

    expect(mode(join(slotDir, ORCAD_READINESS_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, ORCAD_PID_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, ORCAD_LOG_FILENAME))).toBe(0o600)
    expect(mode(slotDir)).toBe(0o700)
    expect(mode(baseDir)).toBe(0o700)
  })

  it('leaves a parent that is not ~/.orca-remote alone', async () => {
    slotDir = join(home, 'custom-slot')
    mkdirSync(slotDir, { mode: 0o755 })
    chmodSync(home, 0o755)
    writeFileSync(join(slotDir, 'orcad.js'), `printf '%s\\n' '${READY_LINE}'\n`)

    await launchUnderLoginUmask()

    expect(mode(home)).toBe(0o755)
    expect(mode(slotDir)).toBe(0o700)
  })
})
