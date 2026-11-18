import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { PROTOCOL_VERSION } from '../protocol/daemon-protocol-version'
import { STORE_FLOOR } from '../../store-compatibility/floor/store-floor-release'
import { buildDaemonScriptArgs } from './daemon-launched-child-spawn'
import { getDaemonEntryPath } from './daemon-launch-paths'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  publishDaemonPidFile
} from './daemon-spawner'

// Frozen from the floor release: how it finds a newer daemon and holds that daemon's terminals
// instead of restoring them a second time (daemon-generation-liveness.ts, daemon-pid-identity.ts).
const FLOOR_PID_FILE = /^daemon-v(\d+)\.pid$/
const floorPid = (contents: string): { pid: number; startedAtMs: number | null } | null => {
  const parsed: unknown = JSON.parse(contents.trim())
  if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed)) {
    return null
  }
  const { pid, startedAtMs } = parsed as { pid: unknown; startedAtMs?: unknown }
  return typeof pid === 'number'
    ? { pid, startedAtMs: typeof startedAtMs === 'number' ? startedAtMs : null }
    : null
}
const floorRecognizesCommandLine = (commandLine: string, socket: string, token: string): boolean =>
  commandLine.includes('daemon-entry') &&
  commandLine.includes(socket) &&
  commandLine.includes(token)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-floor-hold-'))
  setAppEnvironment({
    getPath: () => dir,
    getAppPath: () => dir,
    getVersion: () => '0.0.0',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('names its sockets where the floor release looks for them', () => {
  expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(STORE_FLOOR.daemonProtocolVersion)
  expect(getDaemonTokenPath(dir)).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.token`))
  if (process.platform === 'win32') {
    expect(getDaemonSocketPath(dir)).toMatch(
      new RegExp(`^\\\\\\\\\\?\\\\pipe\\\\orca-terminal-host-v${PROTOCOL_VERSION}-[0-9a-f]{12}$`)
    )
  } else {
    expect(basename(getDaemonSocketPath(dir))).toBe(`daemon-v${PROTOCOL_VERSION}.sock`)
  }
})

it('publishes a pid record the floor release lists and reads', () => {
  publishDaemonPidFile(getDaemonPidPath(dir), { pid: 4321, startedAtMs: 1_700_000_000_000 })
  const listed = readdirSync(dir)
    .map((name) => Number(FLOOR_PID_FILE.exec(name)?.[1]))
    .filter((version) => version > 0)
  expect(listed).toEqual([PROTOCOL_VERSION])
  expect(floorPid(readFileSync(getDaemonPidPath(dir), 'utf8'))).toEqual({
    pid: 4321,
    startedAtMs: 1_700_000_000_000
  })
})

it('starts the daemon with a command line the floor release recognizes as it', () => {
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = getDaemonTokenPath(dir)
  const commandLine = [
    process.execPath,
    getDaemonEntryPath(),
    ...buildDaemonScriptArgs({
      entryPath: getDaemonEntryPath(),
      userDataPath: dir,
      socketPath,
      tokenPath,
      pidPath: getDaemonPidPath(dir),
      launchNonce: 'nonce',
      macosLoginSessionWatch: false
    })
  ].join(' ')
  expect(floorRecognizesCommandLine(commandLine, socketPath, tokenPath)).toBe(true)
})
