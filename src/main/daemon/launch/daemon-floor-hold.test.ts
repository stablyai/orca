import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { PROTOCOL_VERSION } from '../protocol/daemon-protocol-version'
import { STORE_FLOOR } from '../../store-compatibility/fixtures/store-floor-release'
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
// The floor reads a JSON record with a numeric pid; a missing or non-numeric startedAtMs reads as null.
const FloorPidRecord = z.looseObject({ pid: z.number(), startedAtMs: z.unknown().optional() })
const floorPid = (contents: string): { pid: number; startedAtMs: number | null } | null => {
  const parsed = FloorPidRecord.safeParse(JSON.parse(contents.trim()))
  if (!parsed.success) {
    return null
  }
  const { pid, startedAtMs } = parsed.data
  return { pid, startedAtMs: typeof startedAtMs === 'number' ? startedAtMs : null }
}
// The floor's endpoint (daemon-spawner.ts, daemon-socket-endpoint-path.ts): a hashed Windows pipe, or a Unix
// socket relocated under /tmp when the path overflows sun_path (104 bytes on macOS, 108 elsewhere, NUL included).
const floorRuntimeHash = (runtimeDir: string): string =>
  createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
const floorSocketPath = (runtimeDir: string, protocolVersion: number): string => {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\orca-terminal-host-v${protocolVersion}-${floorRuntimeHash(runtimeDir)}`
  }
  const name = `daemon-v${protocolVersion}.sock`
  const preferred = posix.join(runtimeDir, name)
  const uid = process.getuid?.()
  const limit = process.platform === 'darwin' ? 103 : 107
  if (uid === undefined || Buffer.byteLength(preferred) <= limit) {
    return preferred
  }
  return posix.join(`/tmp/.orca-daemon-${uid}/${floorRuntimeHash(runtimeDir)}`, name)
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
  expect(getDaemonSocketPath(dir)).toBe(floorSocketPath(dir, PROTOCOL_VERSION))
  const longDir = join(dir, 'x'.repeat(120))
  expect(getDaemonSocketPath(longDir)).toBe(floorSocketPath(longDir, PROTOCOL_VERSION))
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
