import type * as TerminalBarrier from './orcad-rollback-terminal-barrier'
/**
 * The deploy and rollback drivers end to end against a Windows host whose every host op is answered by a
 * fake: no POSIX command, no `-EncodedCommand` and no PowerShell hop on the orcad path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RecordFile from './orcad-remote-record-file'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))
vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./ssh-relay-install-transfers', () => ({
  uploadRelayDirectory: vi.fn().mockResolvedValue(undefined),
  writeRelayFile: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicOrcadRemoteRecord: vi.fn().mockResolvedValue(undefined)
}))
// The managed stop's Windows commands are covered by orcad-remote-windows-decommission.test.ts.
vi.mock('./orcad-rollback-terminal-barrier', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalBarrier>()),
  readOrcadRollbackBarrierTarget: async (_options: unknown, version: string) => ({
    state: 'ready',
    context: {
      version,
      runtimeId: 'r1',
      instance: { pid: 4242, startedAtMs: 1, nonce: 'n', lockPath: 'C:/l' }
    }
  }),
  stopIncumbentBehindTerminalBarrier: async () => ({ state: 'retired' })
}))
vi.mock('./orcad-remote-node-runtime', () => ({
  ensureRemoteOrcadNodeRuntime: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-local-build-hash', () => ({
  computeLocalOrcadBuildHash: () => 'abc123def4567890'
}))
vi.mock('./ssh-relay-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalFullVersion: () => '0.2.0+bb0100000000',
  isRemoteInstallComplete: vi.fn().mockResolvedValue(false),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined)
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { deployOrcad, type OrcadDeployOptions } from './orcad-remote-deploy'
import { rollbackOrcad } from './orcad-remote-rollback'
import { emptyOrcadActivationRecord } from './orcad-activation-record'
import { writeAtomicOrcadRemoteRecord } from './orcad-remote-record-file'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'

const mockExec = vi.mocked(execCommand)
const host = getRemoteHostPlatform('win32-x64')
const VERSION = '0.2.0+bb0100000000'
const SLOT_NODE = 'C:\\Users\\u\\.orca-remote\\runtimes\\node-ab\\node.exe'

const encoded = (marker: string, value: string): string =>
  `${marker} ${Buffer.from(value).toString('base64')}\r\n`

const TARGET = '0.1.0+aa01'

function readyLine(version = VERSION): string {
  return `${JSON.stringify({
    type: 'orca_server_ready',
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
    health: {
      buildHash: 'abc123def4567890',
      buildVersion: version,
      nodeVersion: NODE_RUNTIME_PIN.version,
      nodeAbi: '137',
      platform: 'win32',
      arch: 'x64',
      pid: 4242,
      stopRequests: 1,
      terminalDaemon: {
        state: 'live',
        ownsFreshSessions: true,
        pid: 2,
        buildVersion: version,
        entryPath: 'C:/x/daemon-entry.js',
        protocolVersion: 3,
        selfTest: { ok: true, coverage: 'handshake', verdict: 'healthy', durationMs: 5 }
      }
    }
  })}\n`
}

function scriptWindowsHost(log: string[], activeRecord: string | null = null): void {
  mockExec.mockImplementation(async (_conn, command: string) => {
    const text = String(command)
    log.push(text)
    const op = /\.js (?:--fence \S+ \S+ )?([a-z-]+)(?: |$)/u.exec(text)?.[1] ?? ''
    switch (op) {
      case 'record-read':
        return activeRecord && text.includes('orcad-active.json')
          ? encoded('__ORCAD_RECORD_PRESENT__', activeRecord)
          : '__ORCAD_RECORD_ABSENT__\r\n'
      case 'build-hash':
        return '__ORCAD_BUILD_HASH__ abc123def4567890\r\n'
      case 'owner-admission':
        return 'CLEAR'
      case 'slot-runtime':
        return encoded('__ORCAD_RUNTIME__', SLOT_NODE)
      case 'readiness-wait':
        return encoded('__ORCAD_READINESS__', readyLine(text.includes(TARGET) ? TARGET : VERSION))
      case 'stop':
        return 'STOPPED'
      case 'snapshot-probe':
        return 'PRESENT'
      case 'snapshot-restore':
        return 'RESTORED'
      case 'state-newest-mtime':
        return 'UNKNOWN'
      case 'snapshot-capture':
        return 'CAPTURED'
      case 'remove-file':
      case 'remove-tree':
        return ''
      case 'fence-check':
        return 'OK'
      case 'fence-release':
        return 'RELEASED'
      default:
        break
    }
    if (text.includes('--orcad-profile-state-preflight')) {
      return JSON.stringify({
        type: 'orca_profile_state_ready',
        nonce: text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0],
        runtime: 'node',
        runtimeVersion: NODE_RUNTIME_PIN.version,
        sqliteVersion: '3.51.0',
        artifactVersion: VERSION,
        revision: 1
      })
    }
    if (text.includes('--windows-breakaway-launch')) {
      return 'ORCA_ORCAD_LAUNCH {"method":"breakaway","pid":4242,"inJob":false}\r\n'
    }
    // The relay's shared install fence is the one pre-existing PowerShell site left on this path.
    if (text.startsWith('powershell.exe ')) {
      return 'OPEN'
    }
    throw new Error(`unexpected Windows command: ${text}`)
  })
}

function options(): OrcadDeployOptions {
  return {
    conn: Object.assign(Object.create(null), { writeFile: vi.fn().mockResolvedValue(undefined) }),
    host,
    remoteHome: 'C:/Users/u',
    localOrcadDir: '/local/out/orcad',
    target: 'win32-x64',
    nodePath: 'C:/host/node.exe',
    userDataDir: 'C:/Users/u/.orca',
    bindHost: '127.0.0.1',
    port: 7777,
    census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
    readinessTimeoutMs: 1_000,
    sleep: async () => {},
    now: () => new Date('2026-10-02T00:00:00.000Z')
  }
}

beforeEach(() => {
  mockExec.mockReset()
  vi.mocked(writeAtomicOrcadRemoteRecord).mockClear()
})

describe('deployOrcad on a Windows host', () => {
  it('activates a first install through node.exe host ops only', async () => {
    const log: string[] = []
    scriptWindowsHost(log)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ outcome: 'installed-and-activated', fullVersion: VERSION })
    const orcadOps = log.filter((command) => !command.startsWith('powershell.exe '))
    expect(orcadOps.length).toBeGreaterThan(0)
    for (const command of orcadOps) {
      expect(command).not.toMatch(/EncodedCommand|nohup|kill |head -c|tar |\bsh -c\b/u)
    }
    const ops = orcadOps.map(
      (command) => /\.js (?:--fence \S+ \S+ )?([a-z-]+)/u.exec(command)?.[1] ?? command
    )
    expect(ops).toContain('owner-admission')
    expect(ops).toContain('snapshot-capture')
    expect(ops.indexOf('slot-runtime')).toBeLessThan(
      ops.findIndex((entry) => entry.includes('--windows-breakaway-launch'))
    )
    expect(ops).toContain('readiness-wait')
    const record = vi
      .mocked(writeAtomicOrcadRemoteRecord)
      .mock.calls.find(([, path]) => path.endsWith('orcad-active.json'))
    expect(JSON.parse(record?.[2] ?? '{}')).toMatchObject({ active: VERSION })
  })

  it('rolls back by managed stop, directory snapshot and node.exe launch', async () => {
    const log: string[] = []
    const record = {
      ...emptyOrcadActivationRecord(),
      active: VERSION,
      previous: TARGET,
      activatedAt: '2026-10-01T00:00:00.000Z',
      snapshot: {
        dirName: `pre-${VERSION}-1000`,
        takenBeforeVersion: VERSION,
        readableByVersion: TARGET,
        takenAt: '2026-10-01T00:00:00.000Z'
      }
    }
    scriptWindowsHost(log, JSON.stringify(record))
    const { localOrcadDir: _dir, target: _target, force: _force, ...base } = options()
    const result = await rollbackOrcad({
      ...base,
      record,
      targetBuildHash: 'abc123def4567890',
      targetDaemonProtocol: { protocolVersion: 3, previousProtocolVersions: [1, 2] }
    })
    expect(result).toMatchObject({ outcome: 'rolled-back', target: TARGET })
    const ops = log.map(
      (command) => /\.js (?:--fence \S+ \S+ )?([a-z-]+)/u.exec(command)?.[1] ?? command
    )
    // The target starts only after its state is back.
    expect(ops).toEqual([
      'record-read',
      'snapshot-probe',
      'state-newest-mtime',
      'build-hash',
      'snapshot-capture',
      'snapshot-restore',
      'slot-runtime',
      // A command the host script does not run is fence-checked by one op just before it.
      'fence-check',
      '--windows-breakaway-launch',
      'readiness-wait',
      'record-read',
      'fence-release'
    ])
    for (const command of log) {
      expect(command).not.toMatch(/EncodedCommand|kill |tar |nohup/u)
    }
  })
})
