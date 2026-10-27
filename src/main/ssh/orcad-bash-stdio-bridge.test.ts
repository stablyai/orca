import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess as Bridge } from '@orca/process-host/process-spec'
import { OrcadStdioBridgeUnavailableError } from '../orcad/orcad-host-unavailable'
import { checkOrcadStdioBridge, type OrcadStdioBridge } from './orcad-stdio-bridge'
import {
  ORCAD_STDIO_BRIDGE_NO_NODE,
  ORCAD_STDIO_BRIDGE_READY,
  ORCAD_STDIO_BRIDGE_REFUSED,
  orcadBashStdioBridgeCommand
} from '../managed-server/lifecycle/orcad-stdio-bridge-script'
import { OrcadStdioBridgeDecoder } from '../managed-server/lifecycle/orcad-stdio-bridge-stream'
import {
  spawnLocalBridgeChannel,
  startEchoServer
} from '../managed-server/lifecycle/orcad-stdio-bridge-test-channel'
import type { OrcadHostTransport } from './orcad-host-transport'
import {
  bashSupportsRelay,
  guestHome,
  isAlive,
  NO_DEV_TCP_EDIT,
  OLD_BASH_EDIT,
  pathWithEditedBash,
  pathWithoutBash,
  processTree,
  treeRssMb
} from './orcad-bash-stdio-bridge-test-host'

const POSIX = process.platform !== 'win32'
// macOS ships bash 3.2, which takes the Node fallback this suite checks separately.
const RELAY = POSIX && bashSupportsRelay()
// Every byte value, repeated into a multi-megabyte frame.
const PAYLOAD = Buffer.from(Array.from({ length: 4 * 1024 * 1024 }, (_, index) => index % 256))
// More than every pipe and socket buffer on the path can hold, so a stalled side must push back.
const FLOOD_CHUNK = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, index) => index % 256))
const FLOOD_BYTES = 128 * FLOOD_CHUNK.length
const STALL_MS = 1_000
// A Node bridge holds ~45-50 MB; the relay is bash plus two cats.
const RELAY_RSS_CEILING_MB = 15

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

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  let text = ''
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('latin1')
      const end = text.indexOf('\n')
      if (end !== -1) {
        stream.off('data', onData)
        resolve(text.slice(0, end))
      }
    }
    stream.on('data', onData)
  })
}

/** Decodes the bridge's stdout: resolves `ready` on the sentinel and `bytes` once `expected` arrived. */
function decode(stream: NodeJS.ReadableStream, expected = 0) {
  const decoder = new OrcadStdioBridgeDecoder('raw')
  stream.pipe(decoder)
  const chunks: Buffer[] = []
  let length = 0
  const ready = new Promise<string>((resolve) => decoder.once('signal', resolve))
  const bytes = new Promise<Buffer>((resolve, reject) => {
    decoder.on('error', reject)
    decoder.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      length += chunk.length
      if (length >= expected) {
        resolve(Buffer.concat(chunks))
      }
    })
  })
  if (expected === 0) {
    decoder.resume()
  }
  return { decoder, ready, bytes }
}

/** Writes like the desktop listener: one chunk at a time, waiting for drain. */
function flood(stream: NodeJS.WritableStream): { accepted: () => number; done: Promise<void> } {
  let accepted = 0
  const done = (async () => {
    while (accepted < FLOOD_BYTES) {
      const more = stream.write(FLOOD_CHUNK)
      accepted += FLOOD_CHUNK.length
      if (!more) {
        await new Promise((resolve) => stream.once('drain', resolve))
      }
    }
  })()
  return { accepted: () => accepted, done }
}

/** Counts flood bytes and checks each one against its position, without holding the flood. */
function floodCheck() {
  let count = 0
  let intact = true
  return {
    push: (chunk: Buffer): void => {
      for (let index = 0; index < chunk.length; index += 1) {
        intact &&= chunk[index] === (count + index) % 256
      }
      count += chunk.length
    },
    count: () => count,
    intact: () => intact
  }
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
  it('announces itself with the unchanged ready sentinel', async () => {
    const child = spawnBridge(echo.port)
    await expect(firstLine(child.stdout)).resolves.toBe(ORCAD_STDIO_BRIDGE_READY)
    child.stdin.end()
    await exitOf(child)
  })

  it('carries every byte value both ways in a multi-megabyte frame, without Node', async () => {
    const child = spawnBridge(echo.port)
    const { ready, bytes } = decode(child.stdout, PAYLOAD.length)
    await ready
    const pids = processTree(child.pid!)
    child.stdin.write(PAYLOAD)
    expect((await bytes).equals(PAYLOAD)).toBe(true)
    if (process.platform === 'linux') {
      expect(treeRssMb(pids)).toBeLessThan(RELAY_RSS_CEILING_MB)
    }
    const exited = exitOf(child)
    child.stdin.end()
    await expect(exited).resolves.toBe(0)
    await expectNoSurvivors(pids)
  })

  it('holds the desktop back, without buffering, while the desktop reads slowly', async () => {
    const child = spawnBridge(echo.port)
    const { decoder, ready } = decode(child.stdout)
    await ready
    decoder.pause()
    const writer = flood(child.stdin)
    // ast-grep-ignore: test-no-real-time-wait -- backpressure is an absence of progress; only a bounded stall shows it
    await new Promise((resolve) => setTimeout(resolve, STALL_MS))
    expect(writer.accepted()).toBeLessThan(FLOOD_BYTES)
    if (process.platform === 'linux') {
      expect(treeRssMb(processTree(child.pid!))).toBeLessThan(RELAY_RSS_CEILING_MB)
    }
    const check = floodCheck()
    decoder.on('data', check.push)
    decoder.resume()
    await writer.done
    await expect.poll(check.count, { timeout: 30_000 }).toBe(FLOOD_BYTES)
    expect(check.intact()).toBe(true)
    child.stdin.end()
    await exitOf(child)
  })

  it('holds the desktop back while orcad reads slowly, then delivers everything', async () => {
    let accepted: Socket | null = null
    const check = floodCheck()
    const server = createServer((socket) => {
      accepted = socket
      socket.pause()
      socket.on('data', check.push)
    })
    const port = await listen(server)
    try {
      const child = spawnBridge(port)
      await decode(child.stdout).ready
      const writer = flood(child.stdin)
      await expect.poll(() => accepted).not.toBeNull()
      // ast-grep-ignore: test-no-real-time-wait -- backpressure is an absence of progress; only a bounded stall shows it
      await new Promise((resolve) => setTimeout(resolve, STALL_MS))
      expect(writer.accepted()).toBeLessThan(FLOOD_BYTES)
      accepted!.resume()
      await writer.done
      await expect.poll(check.count, { timeout: 30_000 }).toBe(FLOOD_BYTES)
      expect(check.intact()).toBe(true)
      child.stdin.end()
      await exitOf(child)
    } finally {
      server.close()
    }
  })

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
    // This cat takes a moment to die and leaves a mark, so the relay must wait to see it.
    const dir = mkdtempSync(join(scratch, 'reap-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'cat'),
      '#!/bin/sh\n' +
        `trap 'kill $c 2>/dev/null; sleep 0.3; : > "${join(dir, 'killed-cat')}"; exit 0' TERM\n` +
        `${realCat()} "$@" & c=$!\nwait $c\n` +
        // The relay starts the socket reader first; the stdin reader stays blocked as on a real
        // host, where the desktop keeps its pipe open.
        `mkdir "${join(dir, 'socket-reader')}" 2>/dev/null || { sleep 30 & c=$!; wait $c; }\n`,
      { mode: 0o755 }
    )
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
      // orcad hangs up: the reading cat ends, the relay kills the one still reading stdin.
      accepted!.destroy()
      await expect(exited).resolves.toBe(0)
      expect(existsSync(join(dir, 'killed-cat'))).toBe(true)
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

  it('falls back to Node when bash was built without /dev/tcp', async () => {
    const child = spawnBridge(echo.port, { PATH: pathWithEditedBash(scratch, NO_DEV_TCP_EDIT) })
    await expect(firstLine(child.stdout)).resolves.toBe(ORCAD_STDIO_BRIDGE_NO_NODE)
    await expect(exitOf(child)).resolves.toBe(127)
  })
})

describe.runIf(POSIX)('the bash stdio bridge’s Node fallback', () => {
  it('relays every byte through the pinned Node on a host without bash', async () => {
    const child = spawnBridge(echo.port, {
      HOME: guestHome(scratch, true),
      PATH: pathWithoutBash(scratch)
    })
    const { ready, bytes } = decode(child.stdout, PAYLOAD.length)
    await expect(ready).resolves.toBe('ready')
    child.stdin.write(PAYLOAD)
    expect((await bytes).equals(PAYLOAD)).toBe(true)
    const exited = exitOf(child)
    child.stdin.end()
    await exited
  })

  it('takes the Node bridge on bash older than 4.3', async () => {
    const child = spawnBridge(echo.port, { PATH: pathWithEditedBash(scratch, OLD_BASH_EDIT) })
    await expect(firstLine(child.stdout)).resolves.toBe(ORCAD_STDIO_BRIDGE_NO_NODE)
    await expect(exitOf(child)).resolves.toBe(127)
  })

  it('reports a refused dial with the unchanged refusal sentinel', async () => {
    const closed = await startEchoServer()
    closed.server.close()
    const child = spawnBridge(closed.port, { HOME: guestHome(scratch, true) })
    await expect(firstLine(child.stdout)).resolves.toBe(
      `${ORCAD_STDIO_BRIDGE_REFUSED} ECONNREFUSED`
    )
    await expect(exitOf(child)).resolves.toBe(0)
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
