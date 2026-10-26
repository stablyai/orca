import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { OrcadStdioBridgeUnavailableError } from '../orcad/orcad-host-unavailable'
import { checkOrcadStdioBridge, type OrcadStdioBridge } from './orcad-stdio-bridge'
import { orcadBashStdioBridgeCommand } from '../managed-server/lifecycle/orcad-stdio-bridge-script'
import { OrcadStdioBridgeDecoder } from '../managed-server/lifecycle/orcad-stdio-bridge-stream'
import {
  spawnLocalBridgeChannel,
  startEchoServer
} from '../managed-server/lifecycle/orcad-stdio-bridge-test-channel'
import type { OrcadHostTransport } from './orcad-host-transport'

function bashSupportsRelay(): boolean {
  const probe = spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], {
    encoding: 'utf8'
  })
  const [major, minor] = (probe.stdout ?? '').trim().split(' ').map(Number)
  return probe.status === 0 && (major > 4 || (major === 4 && minor >= 3))
}

// macOS ships bash 3.2, which takes the Node fallback this suite checks separately.
const RELAY = process.platform !== 'win32' && bashSupportsRelay()
const PAYLOAD = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 256))

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

function home(withRuntime: boolean): string {
  const dir = mkdtempSync(join(scratch, 'home-'))
  if (withRuntime) {
    const bin = join(dir, '.orca-remote', 'runtimes', 'node-abc', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
  }
  return dir
}

/** A PATH that has `cat` but no `bash`, so the command must take its Node fallback. */
function pathWithoutBash(): string {
  const bin = mkdtempSync(join(scratch, 'bin-'))
  const cat = spawnSync('sh', ['-c', 'command -v cat'], { encoding: 'utf8' }).stdout.trim()
  symlinkSync(cat, join(bin, 'cat'))
  return bin
}

function spawnBridge(port: number, env: NodeJS.ProcessEnv) {
  return spawnProcess({ program: '/bin/sh', args: ['-c', orcadBashStdioBridgeCommand(port)], env })
}

function ready(stream: NodeJS.ReadableStream): Promise<string> {
  const decoder = new OrcadStdioBridgeDecoder('raw')
  stream.pipe(decoder)
  decoder.resume()
  return new Promise((resolve) => decoder.once('signal', resolve))
}

/** Resolves with every byte after the sentinel once `expected` bytes arrived. */
function readAfterReady(stream: NodeJS.ReadableStream, expected: number): Promise<Buffer> {
  const decoder = new OrcadStdioBridgeDecoder('raw')
  stream.pipe(decoder)
  const chunks: Buffer[] = []
  let length = 0
  return new Promise((resolve, reject) => {
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

function exitOf(child: ReturnType<typeof spawnProcess>): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

/** Linux RSS of a process and all its descendants, in MB. */
function treeRssMb(rootPid: number): number {
  const parents = new Map<number, number>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))
    } catch {
      // Exited while listing.
    }
  }
  const tree = new Set([rootPid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, parent] of parents) {
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid)
        grew = true
      }
    }
  }
  let kb = 0
  for (const pid of tree) {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    kb += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0)
  }
  return kb / 1024
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server has no port')
  }
  return address.port
}

const bridge = (port: number): OrcadStdioBridge => ({
  command: orcadBashStdioBridgeCommand(port),
  mode: 'raw',
  wrapCommand: true
})

function transportRunning(env: NodeJS.ProcessEnv): OrcadHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check calls only exec.
  return {
    exec: async (command: string) => spawnLocalBridgeChannel('/bin/sh', ['-c', command], env)
  } as unknown as OrcadHostTransport
}

describe.runIf(RELAY)('the bash stdio bridge', () => {
  it('relays every byte both ways without starting Node', async () => {
    const child = spawnBridge(echo.port, { ...process.env, HOME: home(false) })
    const received = readAfterReady(child.stdout, PAYLOAD.length)
    child.stdin.write(PAYLOAD)
    expect((await received).equals(PAYLOAD)).toBe(true)
    if (process.platform === 'linux') {
      // A Node bridge holds ~45-50 MB; the relay is bash plus two cats.
      expect(treeRssMb(child.pid!)).toBeLessThan(15)
    }
    const exited = exitOf(child)
    child.stdin.end()
    await expect(exited).resolves.toBe(0)
  })

  it('exits 0 when orcad closes the socket while the desktop still holds stdin', async () => {
    let accepted: Socket | null = null
    const server = createServer((socket) => {
      accepted = socket
    })
    const port = await listen(server)
    try {
      const child = spawnBridge(port, { ...process.env, HOME: home(false) })
      const exited = exitOf(child)
      await expect(ready(child.stdout)).resolves.toBe('ready')
      await expect.poll(() => accepted).not.toBeNull()
      accepted!.end()
      await expect(exited).resolves.toBe(0)
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
      const child = spawnBridge(port, { ...process.env, HOME: home(false) })
      await expect(ready(child.stdout)).resolves.toBe('ready')
      child.stdin.end()
      await ended
    } finally {
      server.close()
    }
  })
})

describe.runIf(process.platform !== 'win32')('the bash stdio bridge’s Node fallback', () => {
  it('relays through the pinned Node on a host without bash', async () => {
    const child = spawnBridge(echo.port, {
      ...process.env,
      HOME: home(true),
      PATH: pathWithoutBash()
    })
    const received = readAfterReady(child.stdout, PAYLOAD.length)
    child.stdin.write(PAYLOAD)
    expect((await received).equals(PAYLOAD)).toBe(true)
    child.stdin.end()
    child.kill()
  })

  it('still proves the bridge runs when orcad refuses the dial', async () => {
    const closed = await startEchoServer()
    closed.server.close()
    const env = { ...process.env, HOME: home(true) }
    await expect(checkOrcadStdioBridge(transportRunning(env), bridge(closed.port))).resolves.toBe(
      'running'
    )
  })

  it('reports a refused dial with no pinned Node as a bridge that cannot run', async () => {
    const closed = await startEchoServer()
    closed.server.close()
    const env = { ...process.env, HOME: home(false) }
    await expect(
      checkOrcadStdioBridge(transportRunning(env), bridge(closed.port))
    ).rejects.toBeInstanceOf(OrcadStdioBridgeUnavailableError)
  })
})
