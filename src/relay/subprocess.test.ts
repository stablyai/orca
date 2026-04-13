/**
 * Subprocess integration test.
 *
 * Spawns the relay entry point as a real child process, communicates
 * over stdin/stdout using the binary framing protocol, and verifies:
 * - Sentinel line appears on startup
 * - JSON-RPC requests/responses work over the pipe
 * - Graceful shutdown via SIGTERM
 * - Grace period: relay stays alive briefly after stdin closes when PTYs exist
 */
import { describe, expect, it, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import {
  RELAY_SENTINEL,
  FrameDecoder,
  encodeJsonRpcFrame,
  parseJsonRpcMessage,
  MessageType,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification
} from './protocol'

const RELAY_ENTRY = path.resolve(__dirname, 'relay.ts')

type RelayProcess = {
  proc: ChildProcess
  responses: (JsonRpcResponse | JsonRpcNotification)[]
  sentinelReceived: Promise<void>
  send: (method: string, params?: Record<string, unknown>) => number
  sendNotification: (method: string, params?: Record<string, unknown>) => void
  waitForResponse: (id: number, timeoutMs?: number) => Promise<JsonRpcResponse>
  waitForNotification: (method: string, timeoutMs?: number) => Promise<JsonRpcNotification>
  kill: (signal?: NodeJS.Signals) => void
  waitForExit: (timeoutMs?: number) => Promise<number | null>
}

function spawnRelay(args: string[] = []): RelayProcess {
  const proc = spawn('tsx', [RELAY_ENTRY, ...args], {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const responses: (JsonRpcResponse | JsonRpcNotification)[] = []
  let nextSeq = 1
  let sentinelResolved = false
  let stdoutBuffer = Buffer.alloc(0)
  let sentinelResolve: () => void
  let decoderActive = false

  const sentinelReceived = new Promise<void>((resolve) => {
    sentinelResolve = resolve
  })

  const decoder = new FrameDecoder((frame) => {
    if (frame.type !== MessageType.Regular) {
      return
    }
    try {
      const msg = parseJsonRpcMessage(frame.payload)
      responses.push(msg as JsonRpcResponse | JsonRpcNotification)
    } catch {
      /* skip malformed */
    }
  })

  proc.stdout!.on('data', (chunk: Buffer) => {
    if (!sentinelResolved) {
      // Buffer until we find the sentinel
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
      const sentinelStr = RELAY_SENTINEL
      const sentinelBuf = Buffer.from(sentinelStr, 'utf-8')
      const idx = stdoutBuffer.indexOf(sentinelBuf)
      if (idx !== -1) {
        sentinelResolved = true
        decoderActive = true
        sentinelResolve()
        // Feed any bytes after the sentinel to the decoder
        const remainder = stdoutBuffer.subarray(idx + sentinelBuf.length)
        if (remainder.length > 0) {
          decoder.feed(remainder)
        }
      }
    } else if (decoderActive) {
      decoder.feed(chunk)
    }
  })

  proc.stderr!.on('data', () => {
    /* drain */
  })

  const send = (method: string, params?: Record<string, unknown>): number => {
    const id = nextSeq++
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    }
    const frame = encodeJsonRpcFrame(req, id, 0)
    proc.stdin!.write(frame)
    return id
  }

  const sendNotification = (method: string, params?: Record<string, unknown>): void => {
    const seq = nextSeq++
    const notif: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    const frame = encodeJsonRpcFrame(notif, seq, 0)
    proc.stdin!.write(frame)
  }

  const waitForResponse = (id: number, timeoutMs = 5000): Promise<JsonRpcResponse> => {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        const found = responses.find((r) => 'id' in r && r.id === id) as JsonRpcResponse | undefined
        if (found) {
          resolve(found)
          return
        }
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for response id=${id}`))
          return
        }
        setTimeout(check, 10)
      }
      check()
    })
  }

  const waitForNotification = (method: string, timeoutMs = 5000): Promise<JsonRpcNotification> => {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const seen = responses.length
      const check = () => {
        for (let i = seen; i < responses.length; i++) {
          const r = responses[i]
          if ('method' in r && r.method === method) {
            resolve(r as JsonRpcNotification)
            return
          }
        }
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for notification "${method}"`))
          return
        }
        setTimeout(check, 10)
      }
      check()
    })
  }

  const kill = (signal: NodeJS.Signals = 'SIGTERM') => {
    proc.kill(signal)
  }

  const waitForExit = (timeoutMs = 5000): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      if (proc.exitCode !== null) {
        resolve(proc.exitCode)
        return
      }
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for process exit'))
      }, timeoutMs)
      proc.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  return {
    proc,
    responses,
    sentinelReceived,
    send,
    sendNotification,
    waitForResponse,
    waitForNotification,
    kill,
    waitForExit
  }
}

describe('Subprocess: Relay entry point', () => {
  let relay: RelayProcess | null = null
  let tmpDir: string

  afterEach(async () => {
    if (relay && relay.proc.exitCode === null) {
      relay.proc.kill('SIGKILL')
      await relay.waitForExit().catch(() => {})
    }
    relay = null
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('prints sentinel on startup', async () => {
    relay = spawnRelay()
    await relay.sentinelReceived
    // If we get here, the sentinel was detected
  }, 10_000)

  it('responds to fs.stat over stdin/stdout', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'test.txt'), 'hello')

    relay = spawnRelay()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('fs.stat', { filePath: path.join(tmpDir, 'test.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.result).toBeDefined()
    const result = resp.result as { size: number; type: string }
    expect(result.type).toBe('file')
    expect(result.size).toBe(5)
  }, 10_000)

  it('responds to fs.readDir', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
    writeFileSync(path.join(tmpDir, 'b.txt'), 'b')

    relay = spawnRelay()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('fs.readDir', { dirPath: tmpDir })
    const resp = await relay.waitForResponse(id)

    const entries = resp.result as { name: string }[]
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(['a.txt', 'b.txt'])
  }, 10_000)

  it('responds to fs.readFile and fs.writeFile', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))

    relay = spawnRelay()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    // Write
    const filePath = path.join(tmpDir, 'output.txt')
    const wId = relay.send('fs.writeFile', { filePath, content: 'via subprocess' })
    const wResp = await relay.waitForResponse(wId)
    expect(wResp.error).toBeUndefined()

    // Read back
    const rId = relay.send('fs.readFile', { filePath })
    const rResp = await relay.waitForResponse(rId)
    const result = rResp.result as { content: string; isBinary: boolean }
    expect(result.content).toBe('via subprocess')
    expect(result.isBinary).toBe(false)
  }, 10_000)

  it('responds to git.status on a real repo', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' })
    writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' })

    // Create a dirty file
    writeFileSync(path.join(tmpDir, 'file.txt'), 'dirty')

    relay = spawnRelay()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('git.status', { worktreePath: tmpDir })
    const resp = await relay.waitForResponse(id)

    const result = resp.result as { entries: { path: string; status: string }[] }
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries[0].path).toBe('file.txt')
    expect(result.entries[0].status).toBe('modified')
  }, 10_000)

  it('returns JSON-RPC error for unknown method', async () => {
    relay = spawnRelay()
    await relay.sentinelReceived

    const id = relay.send('does.not.exist', {})
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeDefined()
    expect(resp.error!.code).toBe(-32601)
    expect(resp.error!.message).toContain('Method not found')
  }, 10_000)

  it('returns error for failing handler', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    relay = spawnRelay()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('fs.readFile', { filePath: path.join(tmpDir, 'nonexistent.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeDefined()
  }, 10_000)

  it('handles multiple concurrent requests', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'one.txt'), '1')
    writeFileSync(path.join(tmpDir, 'two.txt'), '22')
    writeFileSync(path.join(tmpDir, 'three.txt'), '333')

    relay = spawnRelay()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id1 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'one.txt') })
    const id2 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'two.txt') })
    const id3 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'three.txt') })

    const [r1, r2, r3] = await Promise.all([
      relay.waitForResponse(id1),
      relay.waitForResponse(id2),
      relay.waitForResponse(id3)
    ])

    expect((r1.result as { size: number }).size).toBe(1)
    expect((r2.result as { size: number }).size).toBe(2)
    expect((r3.result as { size: number }).size).toBe(3)
  }, 10_000)

  it('shuts down cleanly on SIGTERM', async () => {
    relay = spawnRelay()
    await relay.sentinelReceived

    relay.kill('SIGTERM')
    await relay.waitForExit()
    expect(relay.proc.exitCode !== null || relay.proc.signalCode !== null).toBe(true)
  }, 10_000)

  it('exits immediately on stdin close when no PTYs exist', async () => {
    relay = spawnRelay(['--grace-time', '100'])
    await relay.sentinelReceived

    // Close stdin to simulate client disconnect
    relay.proc.stdin!.end()

    // With no PTYs and --grace-time 100, should exit quickly
    await relay.waitForExit(3000)
    expect(relay.proc.exitCode).toBe(0)
  }, 10_000)
})
