import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { orcadLivenessProbeCommand, type OrcadLaunchSpec } from './orcad-remote-launch'
import {
  OrcadWindowsLaunchRefusedError,
  readWindowsOrcadLaunchReport,
  windowsOrcadLaunchCommand,
  windowsOrcadLaunchRuntimeCommand
} from './orcad-remote-launch-windows'
import { parseOrcadStopOutcome, stopOrcadCommand } from './orcad-remote-process-control'
import { orcadReadinessWaitCommand } from './orcad-remote-readiness-wait'
import { remoteOrcadBuildHashCommand, readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import {
  readBoundedOrcadRemoteRecord,
  writeAtomicOrcadRemoteRecord
} from './orcad-remote-record-file'
import { launchOrcadAndAwaitReadiness } from './orcad-remote-runtime-control'
import { probeActiveOrcadReadiness } from './orcad-active-readiness'
import { completeRemoteOrcadManagedStop } from './orcad-managed-remote-stop'
import {
  installOrcadWindowsHostScript,
  orcadWindowsNodeCommandLine,
  orcadWindowsPinnedNodePath,
  OrcadWindowsCommandLineError
} from './orcad-remote-windows-node'
import {
  ORCAD_WINDOWS_HOST_SCRIPT,
  ORCAD_WINDOWS_HOST_SCRIPT_FILENAME
} from './orcad-windows-host-script'
import type { OrcadSlotOptions } from './orcad-recovery-slot'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'

const mockExec = vi.mocked(execCommand)
const host = getRemoteHostPlatform('win32-x64')
const base = 'C:/Users/u/.orca-remote'
const slot = `${base}/orcad-0.2.0+bb01`
const sha = NODE_RUNTIME_ASSETS['win32-x64'].executableSha256
const NODE = `C:\\Users\\u\\.orca-remote\\runtimes\\node-${sha}\\node.exe`
const SCRIPT = `${base}/${ORCAD_WINDOWS_HOST_SCRIPT_FILENAME}`
const SLOT_NODE = 'C:\\Users\\u\\.orca-remote\\runtimes\\node-ab\\node.exe'
const spec: OrcadLaunchSpec = {
  remoteInstallDir: slot,
  nodePath: 'C:/host/node.exe',
  fullVersion: '0.2.0+bb01',
  userDataDir: 'C:/Users/u/.orca',
  bindHost: '127.0.0.1',
  port: 7777,
  activationRoot: `${base}/.orcad-activation-transaction`
}

function windowsConn(): { conn: SshConnection; writes: [string, string][] } {
  const writes: [string, string][] = []
  const conn: SshConnection = Object.assign(Object.create(null), {
    writeFile: async (path: string, contents: string) => {
      writes.push([path, contents])
    }
  })
  return { conn, writes }
}

function encoded(marker: string, value: string): string {
  return `${marker} ${Buffer.from(value).toString('base64')}\r\n`
}

beforeEach(() => {
  mockExec.mockReset()
})

describe('Windows orcad commands run node.exe directly', () => {
  const commands = (): [string, string][] => [
    ['launch runtime', windowsOrcadLaunchRuntimeCommand(host, slot)],
    ['launch', windowsOrcadLaunchCommand(host, spec, SLOT_NODE)],
    ['readiness wait', orcadReadinessWaitCommand(host, slot, 20)],
    ['liveness', orcadLivenessProbeCommand(host, slot)],
    ['stop', stopOrcadCommand(host, slot, { waitSeconds: 20, nodePath: spec.nodePath })],
    ['build hash', remoteOrcadBuildHashCommand(host, slot)]
  ]

  it.each(commands())('%s: no PowerShell hop, no encoding, no WMI or signal', (_name, command) => {
    expect(command).toMatch(/^C:\\Users\\u\\\.orca-remote\\runtimes\\node-[0-9a-f]+\\node\.exe /u)
    expect(command).not.toMatch(
      /EncodedCommand|powershell|pwsh|cmd\.exe|ExecutionPolicy|Cim|Wmi|taskkill|SIGTERM|kill -/iu
    )
    // Nothing either DefaultShell expands, and nothing a script would need quoting for.
    expect(command).not.toMatch(/[%$`']/u)
  })

  it('host ops use the client pin; only the launch uses the slot runtime', () => {
    expect(orcadWindowsPinnedNodePath(host, base)).toBe(`${base}/runtimes/node-${sha}/node.exe`)
    expect(orcadLivenessProbeCommand(host, slot)).toBe(`${NODE} ${SCRIPT} liveness ${slot}`)
    expect(stopOrcadCommand(host, slot, { waitSeconds: 20, justLaunched: true })).toBe(
      `${NODE} ${SCRIPT} stop ${slot} "20" "1"`
    )
  })

  it('golden: the two launch lines', () => {
    expect(windowsOrcadLaunchRuntimeCommand(host, slot)).toBe(
      `${NODE} ${SCRIPT} slot-runtime ${slot} clear-stop-request`
    )
    expect(windowsOrcadLaunchCommand(host, spec, SLOT_NODE)).toMatchInlineSnapshot(
      `"C:\\Users\\u\\.orca-remote\\runtimes\\node-ab\\node.exe C:/Users/u/.orca-remote/orcad-0.2.0+bb01/orcad.js --windows-breakaway-launch --stdout-file C:/Users/u/.orca-remote/orcad-0.2.0+bb01/.orcad-readiness --stderr-file C:/Users/u/.orca-remote/orcad-0.2.0+bb01/orcad.log --stderr-keep-previous --process-file C:/Users/u/.orca-remote/orcad-0.2.0+bb01/.orcad-process.json --env ORCA_VERSION=0.2.0+bb01 --env ORCA_USER_DATA=C:/Users/u/.orca --env ORCA_ORCAD_MANAGED_ACTIVATION_ROOT=C:/Users/u/.orca-remote/.orcad-activation-transaction --orcad-args --json --bind "127.0.0.1" --port "7777""`
    )
  })

  it('passes the managed idle-exit fence through the breakaway environment', () => {
    const command = windowsOrcadLaunchCommand(
      host,
      { ...spec, activationRoot: 'C:/Users/u/.orca-remote/.orcad-activation-transaction' },
      SLOT_NODE
    )
    expect(command).toContain(
      '--env ORCA_ORCAD_MANAGED_ACTIVATION_ROOT=C:/Users/u/.orca-remote/.orcad-activation-transaction --orcad-args'
    )
    expect(command).not.toMatch(/[%$`']/u)
  })

  it('never polls across SSH: runtime, launch, then one host-side wait', async () => {
    mockExec
      .mockResolvedValueOnce(encoded('__ORCAD_RUNTIME__', SLOT_NODE))
      .mockResolvedValueOnce(
        'ORCA_ORCAD_LAUNCH {"method":"breakaway","pid":4242,"inJob":false}\r\n'
      )
      .mockResolvedValueOnce(
        encoded(
          '__ORCAD_READINESS__',
          `${JSON.stringify({ type: 'orca_server_ready', runtimeId: 'r1' })}\n`
        )
      )
    const sleep = vi.fn(async () => {})
    const result = await launchOrcadAndAwaitReadiness(
      { conn: Object.create(null), host, readinessTimeoutMs: 60_000, sleep },
      spec
    )
    expect(result).toMatchObject({ state: 'ready', readiness: { runtimeId: 'r1' } })
    expect(mockExec).toHaveBeenCalledTimes(3)
    expect(String(mockExec.mock.calls[1]?.[1]).startsWith(`${SLOT_NODE} `)).toBe(true)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('the active-slot readiness probe on Windows', () => {
  it('reads readiness through the host script instead of the POSIX head command', async () => {
    mockExec
      .mockResolvedValueOnce('LIVE\r\n')
      .mockResolvedValueOnce(
        encoded(
          '__ORCAD_READINESS__',
          `${JSON.stringify({ type: 'orca_server_ready', runtimeId: 'r1' })}\n`
        )
      )
    const probe = probeActiveOrcadReadiness(
      { conn: Object.create(null), host, remoteInstallDir: slot },
      { buildHash: 'bb01', fullVersion: '0.2.0+bb01' }
    )

    // The identity gate may still refuse this payload; the point is that the host is asked.
    await probe.catch((error: unknown) => {
      expect(error).not.toMatchObject({ name: 'OrcadRemoteLaunchUnsupportedError' })
    })
    expect(mockExec.mock.calls[1]?.[1]).toBe(
      `${NODE} ${SCRIPT} readiness-wait ${slot}/.orcad-readiness "262144" "0"`
    )
  })
})

describe('Windows command lines for both DefaultShells', () => {
  it('double-quotes arguments with spaces or leading digits, and passes the rest bare', () => {
    expect(
      orcadWindowsNodeCommandLine('C:/rt/node.exe', ['C:/Users/Ann Lee/x', '20', 'stop'])
    ).toBe('C:\\rt\\node.exe "C:/Users/Ann Lee/x" "20" stop')
  })

  it('falls back to one unencoded powershell -Command when node.exe itself needs quoting', () => {
    expect(
      orcadWindowsNodeCommandLine("C:/Users/Ann O'Lee/rt/node.exe", [
        "C:/Users/Ann O'Lee/x",
        'stop'
      ])
    ).toBe(
      `powershell.exe -NoProfile -NonInteractive -Command "& 'C:\\Users\\Ann O''Lee\\rt\\node.exe' 'C:/Users/Ann O''Lee/x' 'stop'"`
    )
  })

  it.each(['C:/Users/100%/x', 'C:/Users/$me/x', 'C:/Users/a`b/x'])(
    'refuses %s rather than letting a shell expand it',
    (value) => {
      expect(() => orcadWindowsNodeCommandLine('C:/rt/node.exe', [value])).toThrow(
        OrcadWindowsCommandLineError
      )
    }
  )
})

describe('no -EncodedCommand in the W1 builders', () => {
  it.each([
    'orcad-remote-windows-node.ts',
    'orcad-windows-host-script.ts',
    'orcad-remote-launch-windows.ts',
    'orcad-remote-liveness-windows.ts',
    'orcad-remote-process-control-windows.ts',
    'orcad-remote-readiness-wait.ts',
    'orcad-remote-record-file.ts',
    'orcad-remote-build-hash.ts',
    'orcad-managed-remote-stop.ts',
    'orcad-remote-runtime-control.ts'
  ])('%s', (file) => {
    const code = readFileSync(join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '')
    expect(code).not.toMatch(/EncodedCommand|powerShellCommand/u)
  })
})

describe('Windows launch report', () => {
  it('reads a PID, a refusal, or a failure', () => {
    expect(
      readWindowsOrcadLaunchReport('ORCA_ORCAD_LAUNCH {"method":"breakaway","pid":9,"inJob":false}')
    ).toBe(9)
    expect(() =>
      readWindowsOrcadLaunchReport(
        'ORCA_ORCAD_LAUNCH {"method":"unavailable","reason":"breakaway-denied","step":"create-process","code":5}'
      )
    ).toThrow(OrcadWindowsLaunchRefusedError)
    expect(() =>
      readWindowsOrcadLaunchReport(
        'ORCA_ORCAD_LAUNCH {"method":"failed","reason":"failed","step":"open-stdout","code":32}'
      )
    ).toThrow('open-stdout (code 32)')
    // The relay's report is not orcad's.
    expect(() =>
      readWindowsOrcadLaunchReport('ORCA_RELAY_LAUNCH {"method":"breakaway","pid":9,"inJob":false}')
    ).toThrow('no launch report')
  })

  it('reads UNSUPPORTED as a stop refusal', () => {
    expect(parseOrcadStopOutcome('UNSUPPORTED')).toBe('unsupported')
  })
})

describe('Windows build hash and host script', () => {
  it('reads the same marker as POSIX', async () => {
    mockExec.mockResolvedValueOnce('__ORCAD_BUILD_HASH__ ABC123DEF4567890\r\n')
    await expect(readRemoteOrcadBuildHash({ conn: Object.create(null), host }, slot)).resolves.toBe(
      'abc123def4567890'
    )
  })

  it('stages a missing host script through a partial file that installs itself, once per connection', async () => {
    const { conn, writes } = windowsConn()
    mockExec
      .mockRejectedValueOnce(new Error('Cannot find module'))
      .mockResolvedValueOnce('ORCAD_HOST_SCRIPT_PRESENT\r\n')
    await installOrcadWindowsHostScript({ conn, host }, base)
    await installOrcadWindowsHostScript({ conn, host }, base)
    expect(writes).toHaveLength(1)
    const [partial, contents] = writes[0] ?? []
    expect(contents).toBe(ORCAD_WINDOWS_HOST_SCRIPT)
    expect(String(mockExec.mock.calls[0]?.[1])).toBe(`${NODE} ${SCRIPT} script-present`)
    expect(String(mockExec.mock.calls[1]?.[1])).toBe(`${NODE} ${partial} script-install ${SCRIPT}`)
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('never rewrites a host script that is already present', async () => {
    const { conn, writes } = windowsConn()
    mockExec.mockResolvedValueOnce('ORCAD_HOST_SCRIPT_PRESENT\r\n')
    await installOrcadWindowsHostScript({ conn, host }, base)
    expect(writes).toEqual([])
  })
})

describe('Windows host records', () => {
  it('decodes a present record and reads absent as absent', async () => {
    const { conn } = windowsConn()
    const target = { conn, host, remoteHome: 'C:/Users/u' }
    mockExec.mockResolvedValueOnce(encoded('__ORCAD_RECORD_PRESENT__', '{"owner":"Zoë"}'))
    await expect(readBoundedOrcadRemoteRecord(target, 'C:/r.json', 64)).resolves.toEqual({
      state: 'present',
      raw: '{"owner":"Zoë"}'
    })
    expect(String(mockExec.mock.calls[0]?.[1])).toBe(`${NODE} ${SCRIPT} record-read C:/r.json "64"`)
    mockExec.mockResolvedValueOnce('__ORCAD_RECORD_ABSENT__\r\n')
    await expect(readBoundedOrcadRemoteRecord(target, 'C:/r.json', 64)).resolves.toEqual({
      state: 'absent'
    })
    mockExec.mockResolvedValueOnce('')
    await expect(readBoundedOrcadRemoteRecord(target, 'C:/r.json', 64)).rejects.toThrow(
      'no verifiable answer'
    )
  })

  it('refuses a Windows record without the remote home that locates node.exe', async () => {
    await expect(
      readBoundedOrcadRemoteRecord({ conn: Object.create(null), host }, 'C:/r.json', 64)
    ).rejects.toThrow('remote home')
  })

  it('stages the contents as a file and never puts them on a command line', async () => {
    const { conn, writes } = windowsConn()
    mockExec.mockResolvedValueOnce('')
    const contents = '{"secret-ish":"record body"}'
    await writeAtomicOrcadRemoteRecord(
      { conn, host, remoteHome: 'C:/Users/u' },
      'C:/r.json',
      contents
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[0]).toMatch(/^C:\/r\.json\.partial\./u)
    expect(writes[0]?.[1]).toBe(contents)
    const command = String(mockExec.mock.calls[0]?.[1])
    expect(command).not.toContain('record body')
    expect(command.startsWith(`${NODE} ${SCRIPT} record-publish `)).toBe(true)
  })
})

describe('Windows managed stop', () => {
  it('hands orcad a staged request file, not JSON on argv', async () => {
    const { conn, writes } = windowsConn()
    const request = {
      schemaVersion: 1 as const,
      transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
      version: '0.2.0+bb01',
      runtimeId: 'r1',
      instance: { pid: 9, startedAtMs: 5, nonce: 'n', lockPath: 'C:/Users/u/.orca/orcad.lock' }
    }
    mockExec
      .mockResolvedValueOnce(encoded('__ORCAD_RUNTIME__', SLOT_NODE))
      .mockResolvedValueOnce(
        `${JSON.stringify({ ...request, kind: 'orcad_managed_stop_completion', verdict: 'live', receiptPersisted: false })}\r\n`
      )
      .mockResolvedValueOnce('')
    const options: OrcadSlotOptions = {
      conn,
      host,
      remoteHome: 'C:/Users/u',
      nodePath: 'C:/host/node.exe',
      userDataDir: 'C:/Users/u/.orca',
      bindHost: '127.0.0.1',
      port: 7777
    }
    await expect(completeRemoteOrcadManagedStop(options, request)).resolves.toMatchObject({
      verdict: 'live'
    })
    const [stagedPath, stagedBody] = writes[0] ?? ['', '']
    expect(JSON.parse(stagedBody)).toEqual(request)
    expect(String(mockExec.mock.calls[0]?.[1])).toBe(`${NODE} ${SCRIPT} slot-runtime ${slot}`)
    const run = String(mockExec.mock.calls[1]?.[1])
    expect(run).not.toContain(request.transactionId)
    expect(run).toBe(
      `${SLOT_NODE} ${slot}/orcad.js --complete-managed-stop --request-file ${stagedPath}`
    )
    expect(String(mockExec.mock.calls[2]?.[1])).toBe(`${NODE} ${SCRIPT} remove-file ${stagedPath}`)
  })
})
