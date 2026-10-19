import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { wrapRemoteCommandForPosixShell } from './ssh-posix-command-wrapper'
import type { SshExecOptions } from './connection/ssh-exec-options'
import { execCommand } from './remote-exec/remote-exec-command'
import {
  captureOrcadStateSnapshotCommand,
  parseOrcadSnapshotCapture
} from '../managed-server/host-state/orcad-state-snapshot'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type HostOptions = {
  /** PATH on the host; '' leaves only shell builtins, so no base64 or gzip. */
  path?: string
  /** An SSH gateway that cuts the exec request at this many bytes and merges stderr into stdout. */
  gatewayLimitBytes?: number
}

/** A host behind the transport's real wrapper, run by a real /bin/sh. */
function host(options: HostOptions = {}) {
  // Untyped like the rc-noise host: the fake channel carries only what execCommand reads.
  const exec = vi.fn()
  exec.mockImplementation(async (command: string, execOptions?: SshExecOptions) => {
    let remote = wrapRemoteCommandForPosixShell(command, {
      compress: execOptions?.compressCommand === true
    })
    if (options.gatewayLimitBytes !== undefined) {
      remote = `${Buffer.from(remote).subarray(0, options.gatewayLimitBytes).toString()} 2>&1`
    }
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', remote],
      env: { ...process.env, PATH: options.path ?? process.env.PATH ?? '' }
    })
    const channel = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stderr: new EventEmitter(),
      close: () => {}
    })
    setImmediate(() => {
      channel.emit('data', Buffer.from(result.stdout))
      channel.stderr.emit('data', Buffer.from(result.stderr))
      channel.emit('close', result.code ?? 1)
    })
    return channel
  })
  return { exec, usesSystemSshTransport: () => false }
}

const LONG = `printf '%s' ran # ${'padding '.repeat(2_000)}`

describe.skipIf(process.platform === 'win32')(
  'a long command on hosts that cannot decode it (#30491)',
  () => {
    it('resends it uncompressed once, then sends that host every command plain', async () => {
      const conn = host({ path: '' })

      await expect(execCommand(conn, LONG)).resolves.toBe('ran')
      await expect(execCommand(conn, LONG)).resolves.toBe('ran')

      expect(conn.exec.mock.calls.map(([, options]) => options?.compressCommand)).toEqual([
        true,
        false,
        false
      ])
    })

    it('remembers the host across a reconnect that replaces the connection object', async () => {
      const target = { id: 'decoderless-target' }
      const first = { ...host({ path: '' }), getTarget: () => target }
      await expect(execCommand(first, LONG)).resolves.toBe('ran')
      const reconnected = { ...host({ path: '' }), getTarget: () => target }
      await expect(execCommand(reconnected, LONG)).resolves.toBe('ran')
      expect(reconnected.exec.mock.calls.map(([, options]) => options?.compressCommand)).toEqual([
        false
      ])
    })

    it('keeps compressing for a host that has the decoders', async () => {
      const conn = host()
      await expect(execCommand(conn, LONG)).resolves.toBe('ran')
      expect(conn.exec).toHaveBeenCalledTimes(1)
    })

    it('captures a snapshot whole through a gateway that cuts exec requests at 6 KiB and merges stderr', async () => {
      const base = mkdtempSync(join(tmpdir(), 'orcad-gateway-capture-'))
      try {
        const root = join(base, '.orca')
        mkdirSync(join(root, 'profiles'), { recursive: true })
        writeFileSync(join(root, 'profiles', 'p.json'), 'state')
        const snapshot = join(base, '.orca-remote', 'orcad-state-snapshots', 'pre-1')
        const command = captureOrcadStateSnapshotCommand(
          getRemoteHostPlatform('linux-x64'),
          root,
          snapshot,
          join(base, '.orca-remote')
        )
        // Under the byte budget, so even uncompressed nothing is cut.
        const gatewayLimitBytes = 6 * 1024
        expect(
          Buffer.byteLength(wrapRemoteCommandForPosixShell(command, { compress: false }))
        ).toBeLessThan(gatewayLimitBytes)

        const output = await execCommand(host({ gatewayLimitBytes }), command)

        expect(parseOrcadSnapshotCapture(output)).toBe('captured')
        expect(existsSync(join(snapshot, 'state.tar'))).toBe(true)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    })
  }
)
