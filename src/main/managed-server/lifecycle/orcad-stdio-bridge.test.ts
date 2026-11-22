import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:net'

import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../../orcad/diagnostics/orcad-host-unavailable'
import './orcad-stdio-bridge'
import {
  orcadPosixStdioBridgeCommand,
  type OrcadStdioBridgeMode
} from './orcad-stdio-bridge-script'
import { OrcadStdioBridgeBase64Encoder, OrcadStdioBridgeDecoder } from './orcad-stdio-bridge-stream'
import { spawnLocalBridgeChannel, startEchoServer } from './orcad-stdio-bridge-test-channel'
import { ORCAD_WINDOWS_HOST_SCRIPT } from '../host-state/orcad-windows-host-script'

import type { RemoteCommandChannel } from '../install/remote-install-transport'

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

/** Exercise every byte value to expose accidental text conversion. */
const PAYLOAD = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256))

async function roundTrip(
  channel: RemoteCommandChannel,
  mode: OrcadStdioBridgeMode
): Promise<Buffer> {
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

  it('runs on a machine home’s Node, skipping a store runtime that cannot start here', async () => {
    const home = posixHome(false)
    // Another machine's runtime on the shared home, e.g. built for another architecture.
    const foreign = join(home, '.orca-remote', 'runtimes', 'node-abc', 'bin')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'node'), '#!/bin/sh\nexit 126\n', {
      mode: 0o755
    })
    const own = join(home, '.orca-remote', 'hosts', '0123456789abcdef', '.orca-remote')
    const bin = join(own, 'runtimes', 'node-def', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
    const channel = spawnLocalBridgeChannel(
      '/bin/sh',
      ['-c', orcadPosixStdioBridgeCommand(echo.port)],
      { ...process.env, HOME: home }
    )
    expect((await roundTrip(channel, 'raw')).equals(PAYLOAD)).toBe(true)
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
})
