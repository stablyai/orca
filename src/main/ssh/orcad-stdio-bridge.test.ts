import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:net'
import type { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OrcadStdioBridgeUnavailableError } from './orcad-host-unavailable'
import { checkOrcadStdioBridge, type OrcadStdioBridge } from './orcad-stdio-bridge'
import {
  orcadPosixStdioBridgeCommand,
  type OrcadStdioBridgeMode
} from './orcad-stdio-bridge-script'
import { OrcadStdioBridgeBase64Encoder, OrcadStdioBridgeDecoder } from './orcad-stdio-bridge-stream'
import { spawnLocalBridgeChannel, startEchoServer } from './orcad-stdio-bridge-test-channel'
import { ORCAD_WINDOWS_HOST_SCRIPT } from './orcad-windows-host-script'
import type { SshConnection } from './ssh-connection'

const POSIX = process.platform !== 'win32'
let echo: { server: Server; port: number }
let scratch: string

beforeAll(async () => {
  echo = await startEchoServer()
  scratch = mkdtempSync(join(tmpdir(), 'orcad-stdio-bridge-'))
})

afterAll(() => {
  echo.server.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** Every byte value, so a text layer anywhere in the path would show. */
const PAYLOAD = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256))

async function roundTrip(channel: ClientChannel, mode: OrcadStdioBridgeMode): Promise<Buffer> {
  const decoder = new OrcadStdioBridgeDecoder(mode)
  channel.pipe(decoder)
  const input = mode === 'base64' ? new OrcadStdioBridgeBase64Encoder() : new PassThrough()
  input.pipe(channel)
  input.write(PAYLOAD)
  const received: Buffer[] = []
  let length = 0
  await new Promise<void>((resolve, reject) => {
    decoder.on('error', reject)
    decoder.on('data', (chunk: Buffer) => {
      received.push(chunk)
      length += chunk.length
      if (length >= PAYLOAD.length) {
        resolve()
      }
    })
  })
  input.end()
  await new Promise((resolve) => channel.once('close', resolve))
  return Buffer.concat(received)
}

function posixHome(withRuntime: boolean): string {
  const home = mkdtempSync(join(scratch, 'home-'))
  if (withRuntime) {
    const bin = join(home, '.orca-remote', 'runtimes', 'node-abc', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
  }
  return home
}

function connectionRunning(channel: () => ClientChannel): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check calls only exec.
  return { exec: async () => channel() } as unknown as SshConnection
}

const posixBridge = (port: number): OrcadStdioBridge => ({
  command: orcadPosixStdioBridgeCommand(port),
  mode: 'raw',
  wrapCommand: true
})

describe.runIf(POSIX)('the POSIX stdio bridge command', () => {
  it('pipes every byte to orcad and back on the store’s pinned Node', async () => {
    const home = posixHome(true)
    const channel = spawnLocalBridgeChannel(
      '/bin/sh',
      ['-c', orcadPosixStdioBridgeCommand(echo.port)],
      {
        ...process.env,
        HOME: home
      }
    )
    expect((await roundTrip(channel, 'raw')).equals(PAYLOAD)).toBe(true)
  })

  it('proves the bridge runs even when orcad refuses the dial', async () => {
    const closed = await startEchoServer()
    closed.server.close()
    const home = posixHome(true)
    const conn = connectionRunning(() =>
      spawnLocalBridgeChannel('/bin/sh', ['-c', posixBridge(closed.port).command], {
        ...process.env,
        HOME: home
      })
    )
    await expect(checkOrcadStdioBridge(conn, posixBridge(closed.port))).resolves.toBe('running')
  })

  it('reports a host with no pinned Node as one the bridge cannot run on', async () => {
    const home = posixHome(false)
    const conn = connectionRunning(() =>
      spawnLocalBridgeChannel('/bin/sh', ['-c', posixBridge(echo.port).command], {
        ...process.env,
        HOME: home
      })
    )
    await expect(checkOrcadStdioBridge(conn, posixBridge(echo.port))).rejects.toBeInstanceOf(
      OrcadStdioBridgeUnavailableError
    )
  })
})

describe('the Windows host script’s stdio-bridge op', () => {
  it('frames every byte as base64 lines both ways', async () => {
    const script = join(scratch, 'orcad-host-script.js')
    writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
    const channel = spawnLocalBridgeChannel(process.execPath, [
      script,
      'stdio-bridge',
      String(echo.port)
    ])
    expect((await roundTrip(channel, 'base64')).equals(PAYLOAD)).toBe(true)
  })
})

describe('reading a bridge channel', () => {
  it('skips what a login profile prints before the sentinel, and keeps bytes after it', async () => {
    const decoder = new OrcadStdioBridgeDecoder('raw')
    const signals: string[] = []
    decoder.on('signal', (signal: string) => signals.push(signal))
    const out: Buffer[] = []
    decoder.on('data', (chunk: Buffer) => out.push(chunk))
    decoder.write(Buffer.from('Welcome to box\nORCA-STDIO-BRIDGE READY\n\x00\x01'))
    decoder.end(Buffer.from([0xff]))
    await new Promise((resolve) => decoder.on('end', resolve))
    expect(signals).toEqual(['ready'])
    expect(Buffer.concat(out)).toEqual(Buffer.from([0, 1, 0xff]))
  })

  it('decodes base64 lines a PowerShell host rewrote with CRLF', async () => {
    const decoder = new OrcadStdioBridgeDecoder('base64')
    const out: Buffer[] = []
    decoder.on('data', (chunk: Buffer) => out.push(chunk))
    decoder.end(Buffer.from('ORCA-STDIO-BRIDGE READY\r\nAAE=\r\n\r\n/w==\r\n'))
    await new Promise((resolve) => decoder.on('end', resolve))
    expect(Buffer.concat(out)).toEqual(Buffer.from([0, 1, 0xff]))
  })

  it('fails a channel that prints no sentinel within its bound', async () => {
    const decoder = new OrcadStdioBridgeDecoder('raw')
    const failed = new Promise((resolve) => decoder.on('error', resolve))
    decoder.write(Buffer.alloc(70 * 1024, 0x61))
    await expect(failed).resolves.toBeInstanceOf(Error)
  })
})

/** A channel the test drives by hand. */
function scriptedChannel(): ClientChannel & EventEmitter & { stderr: PassThrough } {
  const channel = Object.assign(new PassThrough(), {
    stderr: new PassThrough(),
    close: () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check uses only the stream, `stderr`, `close`, and events.
  return channel as unknown as ClientChannel & EventEmitter & { stderr: PassThrough }
}

describe('checking a bridge before the tunnel relies on it', () => {
  it('reads a channel lost without an exit status as unverifiable, never as unavailable', async () => {
    const channel = scriptedChannel()
    const check = checkOrcadStdioBridge(
      connectionRunning(() => channel),
      posixBridge(1)
    )
    await new Promise((resolve) => setImmediate(resolve))
    channel.emit('close')
    await expect(check).resolves.toBe('unverifiable')
  })

  it('reads a silent bridge as unverifiable once the check times out', async () => {
    const channel = scriptedChannel()
    await expect(
      checkOrcadStdioBridge(
        connectionRunning(() => channel),
        posixBridge(1),
        20
      )
    ).resolves.toBe('unverifiable')
  })

  it('reads a reported exit with no sentinel as a host the bridge cannot run on', async () => {
    const channel = scriptedChannel()
    const check = checkOrcadStdioBridge(
      connectionRunning(() => channel),
      posixBridge(1)
    )
    await new Promise((resolve) => setImmediate(resolve))
    channel.stderr.write('node.exe is not recognized')
    channel.emit('exit', 9009)
    channel.emit('close')
    await expect(check).rejects.toThrow(/exit 9009: node.exe is not recognized/u)
  })

  it('reads a script cut short with no sentinel as unverifiable, not a permanent refusal', async () => {
    const channel = scriptedChannel()
    const check = checkOrcadStdioBridge(
      connectionRunning(() => channel),
      posixBridge(1)
    )
    await new Promise((resolve) => setImmediate(resolve))
    channel.emit('exit', 1)
    channel.emit('close')
    await expect(check).resolves.toBe('unverifiable')
  })

  it('reads an exec channel sshd would not open as unverifiable', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check calls only exec.
    const conn = {
      exec: async () => {
        throw new Error('open failed')
      }
    } as unknown as SshConnection
    await expect(checkOrcadStdioBridge(conn, posixBridge(1))).resolves.toBe('unverifiable')
  })
})
