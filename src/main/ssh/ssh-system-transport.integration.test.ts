import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

import { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { uploadDirectoryViaSystemSsh } from './ssh-system-fallback'
import type { SshTarget } from '../../shared/ssh-types'

const RELAY_VERSION = '0.1.0+systemtransport'

function makeTarget(): SshTarget {
  return {
    id: 'system-transport-target',
    label: 'System Transport Target',
    configHost: 'fdpass-host',
    host: 'ignored.example.com',
    port: 22,
    username: ''
  }
}

function writeFakeSsh(dir: string): string {
  const path = join(dir, 'fake-ssh')
  writeFileSync(
    path,
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-p|-i|-J) shift 2 ;;
    -T) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
if [ "$#" -gt 0 ]; then
  shift
fi
cmd="$1"
if [ -z "$cmd" ]; then
  exit 0
fi
exec /bin/sh -c "$cmd"
`
  )
  chmodSync(path, 0o755)
  return path
}

function writeFakeRelay(dir: string): void {
  writeFileSync(
    join(dir, 'relay.js'),
    `
const fs = require('fs');
const net = require('net');
const sentinel = 'ORCA-RELAY v0.1.0 READY\\n';
const sockPath = process.argv[process.argv.indexOf('--sock-path') + 1];

function encode(msg) {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(13);
  header[0] = 1;
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(0, 5);
  header.writeUInt32BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

function serve(socket) {
  socket.write(sentinel);
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 13) {
      const type = buffer[0];
      const length = buffer.readUInt32BE(9);
      if (buffer.length < 13 + length) return;
      const payload = buffer.subarray(13, 13 + length);
      buffer = buffer.subarray(13 + length);
      if (type !== 1) continue;
      const message = JSON.parse(payload.toString('utf8'));
      if (message.method === 'session.resolveHome') {
        socket.write(encode({ jsonrpc: '2.0', id: message.id, result: process.env.HOME }));
      }
    }
  });
}

if (process.argv.includes('--detached')) {
  try { fs.unlinkSync(sockPath); } catch {}
  const server = net.createServer(serve);
  server.listen(sockPath);
  setTimeout(() => process.exit(0), 20000).unref();
} else if (process.argv.includes('--connect')) {
  process.stdout.write(sentinel);
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 13) {
      const type = buffer[0];
      const length = buffer.readUInt32BE(9);
      if (buffer.length < 13 + length) return;
      const payload = buffer.subarray(13, 13 + length);
      buffer = buffer.subarray(13 + length);
      if (type !== 1) continue;
      const message = JSON.parse(payload.toString('utf8'));
      if (message.method === 'session.resolveHome') {
        process.stdout.write(encode({ jsonrpc: '2.0', id: message.id, result: process.env.HOME }));
      }
    }
  });
}
`
  )
}

function createRelayTree(root: string, remoteHome: string): void {
  const platforms = [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'win32-arm64'
  ]
  for (const platform of platforms) {
    const localDir = join(root, platform)
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, '.version'), RELAY_VERSION)
    writeFakeRelay(localDir)
  }

  const remoteDir = join(remoteHome, '.orca-remote', `relay-${RELAY_VERSION}`)
  mkdirSync(join(remoteDir, 'node_modules', 'node-pty'), { recursive: true })
  mkdirSync(join(remoteDir, 'node_modules', '@parcel', 'watcher'), { recursive: true })
  writeFileSync(join(remoteDir, 'node_modules', 'node-pty', 'index.js'), '')
  writeFileSync(join(remoteDir, 'node_modules', '@parcel', 'watcher', 'index.js'), '')
  writeFileSync(join(remoteDir, '.install-complete'), '')
  writeFakeRelay(remoteDir)
}

describe('system SSH transport integration', () => {
  let tempDir: string
  let oldHome: string | undefined
  let oldRelayPath: string | undefined
  let oldSystemSshPath: string | undefined
  let oldForceSystemTransport: string | undefined

  beforeEach(() => {
    if (process.platform === 'win32') {
      return
    }
    tempDir = mkdtempSync(join('/tmp', 'orca-ssh-'))
    oldHome = process.env.HOME
    oldRelayPath = process.env.ORCA_RELAY_PATH
    oldSystemSshPath = process.env.ORCA_SYSTEM_SSH_PATH
    oldForceSystemTransport = process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT
    const remoteHome = join(tempDir, 'remote-home')
    const relayRoot = join(tempDir, 'relay')
    mkdirSync(remoteHome, { recursive: true })
    createRelayTree(relayRoot, remoteHome)
    process.env.HOME = remoteHome
    process.env.ORCA_RELAY_PATH = relayRoot
    process.env.ORCA_SYSTEM_SSH_PATH = writeFakeSsh(tempDir)
    process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT = '1'
  })

  afterEach(() => {
    if (process.platform === 'win32') {
      return
    }
    if (oldHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = oldHome
    }
    if (oldRelayPath === undefined) {
      delete process.env.ORCA_RELAY_PATH
    } else {
      process.env.ORCA_RELAY_PATH = oldRelayPath
    }
    if (oldSystemSshPath === undefined) {
      delete process.env.ORCA_SYSTEM_SSH_PATH
    } else {
      process.env.ORCA_SYSTEM_SSH_PATH = oldSystemSshPath
    }
    if (oldForceSystemTransport === undefined) {
      delete process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT
    } else {
      process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT = oldForceSystemTransport
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  // Why: this fixture writes a POSIX fake ssh script to exercise stdin/stdout
  // transport semantics; Windows coverage stays in argument/unit tests.
  it.skipIf(process.platform === 'win32')(
    'deploys and speaks relay RPC over a system ssh process for ProxyUseFdpass targets',
    async () => {
      const conn = new SshConnection(makeTarget(), { onStateChange: vi.fn() })
      await conn.connect()
      expect(conn.usesSystemSshTransport()).toBe(true)

      const result = await deployAndLaunchRelay(conn, undefined, 60, makeTarget().id)
      const mux = new SshChannelMultiplexer(result.transport)
      try {
        await expect(mux.request('session.resolveHome', { path: '~' })).resolves.toBe(
          join(tempDir, 'remote-home')
        )
      } finally {
        mux.dispose()
        await conn.disconnect()
      }
    },
    20_000
  )

  it.skipIf(process.platform === 'win32')(
    'uploads a directory through the system ssh stdin/stdout path',
    async () => {
      const source = join(tempDir, 'source')
      const destination = join(tempDir, 'uploaded')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'payload.txt'), 'uploaded over system ssh')

      await uploadDirectoryViaSystemSsh(makeTarget(), source, destination)

      expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe(
        'uploaded over system ssh'
      )
    }
  )
})
