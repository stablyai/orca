// Why: shared by the native-deps install specs so each file stays under the max-lines cap; the
// vi.mock of ./ssh-relay-deploy-helpers in the importing spec is hoisted, so execCommand is mocked here too.
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'

export type SftpWriteCapture = {
  paths: string[]
  contents: Record<string, string>
  // execCommand call count observed when ws.end() ran, per path — pins "package.json written before npm install".
  execCallCountAtWrite: Record<string, number>
}

type SftpCallback = (err: Error | null, resolved?: string) => void
const NO_SUCH_SFTP_FILE = Object.assign(new Error('No such file'), { code: 2 })

export function makeMockConnection(capture: SftpWriteCapture): SshConnection {
  // Why: production attaches/removes real listeners (including prependOnceListener), so the fake must be an emitter.
  const sftpCreate = (): unknown => {
    const sftp = new EventEmitter()
    return Object.assign(sftp, {
      mkdir: vi.fn((_p: string, cb: SftpCallback) => cb(null)),
      // This host's shell home and SFTP start directory agree, so no namespace redirect is possible.
      realpath: vi.fn((_p: string, cb: SftpCallback) => cb(null, '/home/u')),
      lstat: vi.fn((_p: string, cb: SftpCallback) => cb(NO_SUCH_SFTP_FILE)),
      createWriteStream: vi.fn().mockImplementation((path: string) => {
        capture.paths.push(path)
        const ws = new EventEmitter()
        return Object.assign(ws, {
          end: vi.fn((data?: string) => {
            capture.contents[path] = `${capture.contents[path] ?? ''}${data ?? ''}`
            capture.execCallCountAtWrite[path] = vi.mocked(execCommand).mock.calls.length
            setTimeout(() => ws.emit('close'), 0)
          })
        })
      }),
      end: vi.fn(() => setTimeout(() => sftp.emit('close'), 0))
    })
  }
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(false),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    sftp: vi.fn().mockImplementation(() => Promise.resolve(sftpCreate()))
  } as unknown as SshConnection
}

export type ExecResponse = string | { reject: string }

// Repair reconnect (isRelayAlreadyInstalled → true) where BOTH native deps are broken and the host
// cannot compile node-pty, so the caller's resets must survive into the node-pty-less reinstall.
export function makeRepairToolchainSkipExecResponses(): ExecResponse[] {
  const bothMissing = 'ORCA-NATIVE-DEPS-MISSING:node-pty,@parcel/watcher\nMISSING'
  return [
    '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
    '/home/u',
    bothMissing, // health probe before lock
    bothMissing, // re-probe under the repair lock
    '', // SFTP-namespace install-owner marker (repair)
    { reject: 'gyp ERR! stack Error: not found: make' },
    'PKG apk', // toolchain probe: no HAVE lines
    '', // reset both deps + reinstall without node-pty
    'ORCA-NATIVE-DEPS-MISSING:node-pty\nMISSING\n', // watcher probe: only node-pty still absent
    '', // cat probe stderr
    '', // rm -f probe stderr
    'DEAD',
    '', // publish the per-launch credential
    'READY'
  ]
}

export function decodePowerShellCommand(command: string): string | null {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : null
}

// Happy-path exec order ends with socket probe, credential publication, then readiness poll.
// When the probe rejects (SSH channel close or vanished install dir), the catch skips both stderr-capture and the rm.
// A failed npm install takes one of the two early branches below instead, which never reach `probe`.
export function makeExecResponses(opts: {
  npmInstall: 'ok' | { reject: string }
  // Only consumed when npmInstall is 'ok'; defaults to a healthy install.
  // 'ok'      : probe resolves with the sentinel; rm runs once
  // 'missing' : probe resolves with 'MISSING'; cat stderr + rm both run
  // 'dir-gone': probe rejects (cd-failure), exec rejects directly
  // { reject }: probe rejects with custom error (e.g. SSH channel)
  probe?: 'ok' | 'missing' | 'dir-gone' | { reject: string }
  // Override probe stdout entirely for shell-noise/pollution-prefix pressure tests.
  probeStdoutOverride?: string
  // Result after the automatic rebuild; defaults to missing so legacy tests still exercise the degraded-mode warning.
  repairProbe?: 'ok' | 'missing'
  // Raw stdout for the toolchain probe in installNativeDeps' catch; defaults to a full toolchain so the original npm error propagates unchanged.
  toolchainProbe?: string
  // Result of the node-pty-less reinstall the catch attempts when the toolchain is missing.
  // Omit for hosts that never reach it (full toolchain, or a non-build npm failure).
  nodePtySkipRetry?: 'ok' | { reject: string }
  // Whether @parcel/watcher loads on the skip path; node-pty is always absent there by construction.
  nodePtySkipWatcher?: 'ok' | 'missing'
}): ExecResponse[] {
  // A failed npm install aborts after the catch probes the toolchain, unless the node-pty-less
  // reinstall succeeds; only then are the chmod/probe/launch slots reached.
  if (opts.npmInstall !== 'ok' && opts.nodePtySkipRetry !== 'ok') {
    return [
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      '', // mkdir remoteDir (uploadRelay)
      '', // chmod +x node
      opts.npmInstall, // npm install rejects
      opts.toolchainProbe ?? 'HAVE make\nHAVE g++\nHAVE cc\nHAVE python3\nPKG apt-get',
      ...(opts.nodePtySkipRetry ? [opts.nodePtySkipRetry] : []) // reinstall also rejects
    ]
  }
  if (opts.npmInstall !== 'ok') {
    // Skip path, exactly as production runs it: no chmod-prebuilds (node-pty is gone) and no rebuild
    // (it provably can't compile here). The probe still runs to catch a dead @parcel/watcher.
    return [
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      '', // mkdir remoteDir (uploadRelay)
      '', // chmod +x node
      opts.npmInstall, // npm install rejects on the missing compiler
      opts.toolchainProbe ?? 'HAVE python3\nPKG dnf',
      '', // rm -rf node-pty + reinstall without it
      // node-pty is always reported missing here; the probe never resolves OK, so cat + rm both run.
      opts.nodePtySkipWatcher === 'missing'
        ? 'ORCA-NATIVE-DEPS-MISSING:node-pty,@parcel/watcher\nMISSING\n'
        : 'ORCA-NATIVE-DEPS-MISSING:node-pty\nMISSING\n',
      '', // cat probe stderr
      '', // rm -f probe stderr
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ]
  }
  const probe = opts.probe ?? 'ok'
  const probeSlot: ExecResponse =
    opts.probeStdoutOverride !== undefined
      ? opts.probeStdoutOverride
      : probe === 'ok'
        ? 'ORCA-NPTY-PROBE-OK\n'
        : probe === 'missing'
          ? 'MISSING\n' // shell-level `|| echo MISSING` after require throw
          : probe === 'dir-gone'
            ? { reject: 'cd: no such file or directory' }
            : probe
  const slots: ExecResponse[] = [
    '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
    '/home/u',
    '', // mkdir remoteDir (uploadRelay)
    '', // chmod +x node
    '', // npm install native deps
    '', // chmod prebuilds
    probeSlot
  ]
  // Cleanup execs only run when the probe resolved (not when it rejected).
  const probeResolved = typeof probeSlot === 'string'
  if (probeResolved) {
    const probeOk = probeSlot.includes('ORCA-NPTY-PROBE-OK')
    if (!probeOk) {
      slots.push('') // cat stderr (graceful failure path captures detail)
    }
    slots.push('') // rm -f stderr (best-effort cleanup)
    if (!probeOk) {
      slots.push('') // npm rebuild with lifecycle scripts explicitly enabled
      slots.push('') // chmod prebuilds after rebuild
      const repairProbe = opts.repairProbe === 'ok' ? 'ORCA-NPTY-PROBE-OK\n' : 'MISSING\n'
      slots.push(repairProbe)
      if (!repairProbe.includes('ORCA-NPTY-PROBE-OK')) {
        slots.push('') // cat stderr after unsuccessful rebuild
      }
      slots.push('') // rm -f stderr after rebuild probe
    }
  }
  slots.push('DEAD', '', 'READY')
  return slots
}
