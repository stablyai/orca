import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess as Bridge } from '@orca/process-host/process-spec'
import { OrcadStdioBridgeUnavailableError } from '../../orcad/orcad-host-unavailable'
import { checkOrcadStdioBridge, type OrcadStdioBridge } from './orcad-stdio-bridge'
import { orcadBashStdioBridgeCommand } from './orcad-stdio-bridge-script'
import { OrcadStdioBridgeDecoder } from './orcad-stdio-bridge-stream'
import { spawnLocalBridgeChannel, startEchoServer } from './orcad-stdio-bridge-test-channel'
import type { OrcadHostTransport } from '../install/orcad-host-transport'
import {
  bashSupportsRelay,
  guestHome,
  isAlive,
  pathWithoutBash,
  processTree
} from './testing/orcad-bash-stdio-bridge-test-host'

const POSIX = process.platform !== 'win32'
// macOS ships bash 3.2, which takes the Node fallback this suite checks separately.
const RELAY = POSIX && bashSupportsRelay()
// Every byte value, repeated into a multi-megabyte frame.
const PAYLOAD = Buffer.from(Array.from({ length: 4 * 1024 * 1024 }, (_, index) => index % 256))

let echo: { server: Server; port: number }
let scratch: string

beforeAll(async () => {
  echo = await startEchoServer()
  scratch = mkdtempSync(join(tmpdir(), 'orcad-bash-stdio-bridge-'))
})

afterAll(() => {
  echo.server.close()
  rmSync(scratch, { recursive: true, force: true })
})

function spawnBridge(port: number, env: Partial<NodeJS.ProcessEnv> = {}): Bridge {
  return spawnProcess({
    program: '/bin/sh',
    args: ['-c', orcadBashStdioBridgeCommand(port)],
    env: { ...process.env, HOME: guestHome(scratch, false), ...env }
  })
}

function realCat(): string {
  return spawnSync('sh', ['-c', 'command -v cat'], { encoding: 'utf8' }).stdout.trim()
}

function exitOf(child: Bridge): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

/** Decodes the bridge's stdout, discarding payload bytes; resolves `ready` on the sentinel. */
function decode(stream: NodeJS.ReadableStream) {
  const decoder = new OrcadStdioBridgeDecoder('raw')
  stream.pipe(decoder)
  const ready = new Promise<string>((resolve) => decoder.once('signal', resolve))
  decoder.resume()
  return { decoder, ready }
}

/** Resolves with the payload once `expected` bytes arrived; collecting a flood would copy quadratically. */
function received(decoder: OrcadStdioBridgeDecoder, expected: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  return new Promise<Buffer>((resolve, reject) => {
    decoder.on('error', reject)
    decoder.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      length += chunk.length
      if (length >= expected) {
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server has no port')
  }
  return address.port
}

async function expectNoSurvivors(pids: readonly number[]): Promise<void> {
  await expect.poll(() => pids.filter(isAlive), { timeout: 5_000 }).toEqual([])
}

const bridge = (port: number): OrcadStdioBridge => ({
  command: orcadBashStdioBridgeCommand(port),
  mode: 'raw',
  wrapCommand: true
})

function transportRunning(env: Partial<NodeJS.ProcessEnv>): OrcadHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check calls only exec.
  return {
    exec: async (command: string) =>
      spawnLocalBridgeChannel('/bin/sh', ['-c', command], { ...process.env, ...env })
  } as unknown as OrcadHostTransport
}

describe.runIf(RELAY)('the bash stdio bridge', () => {
  it('exits 0 and leaves nothing running when orcad closes while the desktop holds stdin', async () => {
    let accepted: Socket | null = null
    const server = createServer((socket) => {
      accepted = socket
    })
    const port = await listen(server)
    try {
      const child = spawnBridge(port)
      const exited = exitOf(child)
      await decode(child.stdout).ready
      const pids = processTree(child.pid!)
      await expect.poll(() => accepted).not.toBeNull()
      accepted!.destroy()
      await expect(exited).resolves.toBe(0)
      await expectNoSurvivors(pids)
    } finally {
      server.close()
    }
  })

  it('waits for the cat it kills before exiting, so no zombie is left for the session init', async () => {
    // WSL's per-session init never reaps orphans; a zombie there kept an idle distro running (R40).
    // The stub cats mark when their TERM trap is in place, and the one the relay kills takes a
    // moment to die and leaves a mark: the relay may exit only after that mark exists.
    const dir = mkdtempSync(join(scratch, 'reap-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'cat'),
      '#!/bin/sh\n' +
        `trap 'kill $c 2>/dev/null; sleep 0.3; : > "${join(dir, 'killed')}"; exit 0' TERM\n` +
        // POSIX gives a background job /dev/null as stdin even under `<&0`, so hand it over on fd 5
        // as the relay does: the socket reader ends with orcad, the stdin reader blocks until killed.
        `exec 5<&0\n${realCat()} "$@" <&5 & c=$!\nexec 5<&-\n` +
        `: > "${join(dir, 'trap')}.$$"\nwait $c\n`,
      { mode: 0o755 }
    )
    const trapsSet = (): number =>
      readdirSync(dir).filter((name) => name.startsWith('trap.')).length
    let accepted: Socket | null = null
    const server = createServer((socket) => {
      accepted = socket
    })
    const port = await listen(server)
    try {
      const child = spawnBridge(port, { PATH: `${bin}:${process.env.PATH}` })
      const exited = exitOf(child)
      await decode(child.stdout).ready
      await expect.poll(() => accepted).not.toBeNull()
      // Hang up only once both cats can take the relay's kill on their trap.
      await expect.poll(trapsSet, { timeout: 10_000 }).toBe(2)
      // orcad hangs up: the socket reader ends, the relay kills the stdin reader.
      accepted!.destroy()
      await expect(exited).resolves.toBe(0)
      expect(existsSync(join(dir, 'killed'))).toBe(true)
    } finally {
      server.close()
    }
  })

  it('closes orcad’s socket as soon as the desktop ends stdin', async () => {
    const server = createServer()
    const ended = new Promise<void>((resolve) => {
      server.on('connection', (socket) => {
        socket.resume()
        socket.on('end', resolve)
      })
    })
    const port = await listen(server)
    try {
      const child = spawnBridge(port)
      await decode(child.stdout).ready
      const pids = processTree(child.pid!)
      child.stdin.end()
      await ended
      await expectNoSurvivors(pids)
    } finally {
      server.close()
    }
  })

  it('leaves nothing running when the desktop side vanishes and orcad stays silent', async () => {
    const server = createServer((socket) => socket.resume())
    const port = await listen(server)
    try {
      const child = spawnBridge(port)
      await decode(child.stdout).ready
      const pids = processTree(child.pid!)
      // wsl.exe dying closes both pipes without signalling the guest.
      child.stdin.destroy()
      child.stdout.destroy()
      await expectNoSurvivors(pids)
    } finally {
      server.close()
    }
  })
})

describe.runIf(POSIX)('the bash stdio bridge’s Node fallback', () => {
  it('relays every byte through the pinned Node on a host without bash', async () => {
    const child = spawnBridge(echo.port, {
      HOME: guestHome(scratch, true),
      PATH: pathWithoutBash(scratch)
    })
    const { decoder, ready } = decode(child.stdout)
    const bytes = received(decoder, PAYLOAD.length)
    await expect(ready).resolves.toBe('ready')
    child.stdin.write(PAYLOAD)
    expect((await bytes).equals(PAYLOAD)).toBe(true)
    const exited = exitOf(child)
    child.stdin.end()
    await exited
  })

  it('still proves the bridge runs when orcad refuses the dial', async () => {
    const closed = await startEchoServer()
    closed.server.close()
    await expect(
      checkOrcadStdioBridge(
        transportRunning({ HOME: guestHome(scratch, true) }),
        bridge(closed.port)
      )
    ).resolves.toBe('running')
  })

  it('reports a refused dial with no pinned Node as a bridge that cannot run', async () => {
    const closed = await startEchoServer()
    closed.server.close()
    await expect(
      checkOrcadStdioBridge(
        transportRunning({ HOME: guestHome(scratch, false) }),
        bridge(closed.port)
      )
    ).rejects.toBeInstanceOf(OrcadStdioBridgeUnavailableError)
  })
})
