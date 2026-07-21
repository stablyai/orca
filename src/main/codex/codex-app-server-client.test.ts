import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError,
  isCodexAppServerUnsupportedError,
  runCodexHookTrustGrantSession,
  type CodexHookTrustGrantRequest
} from './codex-app-server-client'
import { killCodexAppServerProcessTree, runCodexAppServerSession } from './codex-app-server-session'
import {
  resolveCodexGrantEntryPath,
  runCodexHookTrustGrantSessionSync
} from './codex-app-server-grant-bridge'

// Stub codex app-server speaking the same JSONL protocol: initialize →
// initialized → hooks/list → config/batchWrite → hooks/list. Scenario-driven
// via STUB_CONFIG so each test controls listings, errors, and hangs.
const STUB_SERVER_SOURCE = `
const config = JSON.parse(process.env.STUB_CONFIG)
require('node:fs').writeFileSync(config.pidFile, String(process.pid))
const trusted = new Set(config.hooks.filter(h => h.trustStatus === 'trusted').map(h => h.key))
let buffer = ''
function send(message) {
  const serialized = Buffer.from(JSON.stringify(message) + '\\n')
  if (config.scenario === 'split-unicode') {
    const marker = Buffer.from('é')
    const markerIndex = serialized.indexOf(marker)
    if (markerIndex !== -1) {
      process.stdout.write(serialized.subarray(0, markerIndex + 1))
      setTimeout(() => process.stdout.write(serialized.subarray(markerIndex + 1)), 5)
      return
    }
  }
  process.stdout.write(serialized)
}
function listing() {
  return {
    data: [{
      cwd: config.cwd,
      hooks: config.hooks.map(h => ({ ...h, trustStatus: trusted.has(h.key) ? 'trusted' : h.trustStatus })),
      warnings: [],
      errors: []
    }]
  }
}
if (config.scenario === 'no-subcommand') {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
if (config.scenario === 'transient-stderr') {
  process.stderr.write('config loader: unexpected argument in value\\n')
  process.exit(1)
}
if (config.scenario === 'silent-exit-0') process.exit(0)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'stub/0.0.0' } })
      continue
    }
    if (message.method === 'initialized') continue
    if (config.scenario === 'hang') continue
    if (message.method === 'hooks/list') {
      if (config.scenario === 'unknown-method') {
        send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
        continue
      }
      send({ id: message.id, result: listing() })
      continue
    }
    if (message.method === 'config/batchWrite') {
      if (config.scenario === 'reject-write') {
        process.exit(9)
      }
      writeFileSyncSafe(config.recordFile, JSON.stringify(message.params))
      for (const key of Object.keys(message.params.edits[0].value)) trusted.add(key)
      send({ id: message.id, result: { status: 'ok', version: 'v1', filePath: config.cwd + '/config.toml' } })
      continue
    }
  }
})
process.stdin.on('end', () => process.exit(0))
function writeFileSyncSafe(file, contents) { require('node:fs').writeFileSync(file, contents) }
`

let tempRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

type StubHook = {
  key: string
  command: string | null
  currentHash: string
  trustStatus: string
}

function createStubRequest(options: {
  scenario: string
  hooks: StubHook[]
  expectedTrustKeys: string[]
  managedCommand: string
  timeoutMs?: number
}): { request: CodexHookTrustGrantRequest; recordFile: string; pidFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-stub-'))
  tempRoots.push(root)
  const stubPath = join(root, 'stub-app-server.cjs')
  writeFileSync(stubPath, STUB_SERVER_SOURCE)
  const recordFile = join(root, 'batch-write-params.json')
  const pidFile = join(root, 'app-server.pid')
  return {
    recordFile,
    pidFile,
    request: {
      invocation: {
        command: process.execPath,
        args: [stubPath],
        env: {
          STUB_CONFIG: JSON.stringify({
            scenario: options.scenario,
            hooks: options.hooks,
            cwd: root,
            recordFile,
            pidFile
          })
        },
        timeoutMs: options.timeoutMs ?? 10_000
      },
      hooksListCwd: root,
      expectedTrustKeys: options.expectedTrustKeys,
      managedCommand: options.managedCommand
    }
  }
}

const MANAGED_COMMAND = "/bin/sh '/tmp/orca/codex-hook.sh'"

function managedHook(key: string, trustStatus = 'untrusted'): StubHook {
  return { key, command: MANAGED_COMMAND, currentHash: `sha256:hash-of-${key}`, trustStatus }
}

describe('killCodexAppServerProcessTree', () => {
  it('kills the Windows wrapper and all app-server descendants', () => {
    const child = {
      pid: 1234,
      kill: vi.fn(() => true) as ChildProcess['kill']
    }
    const killer = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    killer.unref = vi.fn()
    const spawnImpl = vi.fn(() => killer) as unknown as typeof spawn

    killCodexAppServerProcessTree(child, { platform: 'win32', spawnImpl })

    expect(spawnImpl).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    expect(killer.unref).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()

    killer.emit('error', new Error('taskkill unavailable'))
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('falls back when taskkill starts but cannot terminate the process tree', () => {
    const child = {
      pid: 1234,
      kill: vi.fn(() => true) as ChildProcess['kill']
    }
    const killer = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    killer.unref = vi.fn()
    const spawnImpl = vi.fn(() => killer) as unknown as typeof spawn

    killCodexAppServerProcessTree(child, { platform: 'win32', spawnImpl })
    killer.emit('exit', 1)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills the direct app-server process on non-Windows hosts', () => {
    const child = {
      pid: 1234,
      kill: vi.fn(() => true) as ChildProcess['kill']
    }
    const spawnImpl = vi.fn() as unknown as typeof spawn

    killCodexAppServerProcessTree(child, { platform: 'linux', spawnImpl })

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('runCodexHookTrustGrantSession', () => {
  it('stops stdout before killing a server with an oversized response', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdin = new PassThrough()
    const stdout = new PassThrough()
    child.stdout = stdout
    child.stderr = new PassThrough()
    const kill = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('exit', null, 'SIGKILL')
        child.emit('close', null, 'SIGKILL')
      })
      return true
    })
    child.kill = kill as ChildProcess['kill']
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn

    const session = runCodexAppServerSession(
      { command: 'codex', args: ['app-server'], timeoutMs: 2_000 },
      async () => undefined,
      spawnImpl
    )
    stdout.write('x'.repeat(1024 * 1024 + 1))
    stdout.write('more buffered output')

    await expect(session).rejects.toThrow('oversized JSONL response')
    expect(child.stdout.destroyed).toBe(true)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('grants and verifies exactly the expected managed entries', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const keys = [
      '/home/a/.codex/hooks.json:session_start:0:0',
      '/home/a/.codex/hooks.json:stop:0:0'
    ]
    const userHook: StubHook = {
      key: '/home/a/.codex/hooks.json:stop:1:0',
      command: 'echo user-hook',
      currentHash: 'sha256:user-hash',
      trustStatus: 'untrusted'
    }
    const { request, recordFile } = createStubRequest({
      scenario: 'happy',
      hooks: [...keys.map((key) => managedHook(key)), userHook],
      expectedTrustKeys: keys,
      managedCommand: MANAGED_COMMAND
    })

    const result = await runCodexHookTrustGrantSession(request)
    expect(result.outcome).toBe('granted')
    if (result.outcome !== 'granted') {
      return
    }
    expect(result.wroteTrust).toBe(true)
    expect(result.entries.map((entry) => entry.key).sort()).toEqual([...keys].sort())
    expect(result.entries.map((entry) => entry.trustedHash).sort()).toEqual(
      keys.map((key) => `sha256:hash-of-${key}`).sort()
    )

    // Why: the write must never include user hooks, even untrusted ones.
    const written = JSON.parse(readFileSync(recordFile, 'utf-8')) as {
      edits: {
        keyPath: string
        value: Record<string, { trusted_hash: string }>
        mergeStrategy: string
      }[]
      reloadUserConfig: boolean
    }
    expect(written.edits).toHaveLength(1)
    expect(written.edits[0].keyPath).toBe('hooks.state')
    expect(written.edits[0].mergeStrategy).toBe('upsert')
    expect(Object.keys(written.edits[0].value).sort()).toEqual([...keys].sort())
    expect(written.reloadUserConfig).toBe(true)
    // Why: the entry process waits on these handles after setting exitCode, so
    // an uncleared grace timer adds its full delay to synchronous launch prep.
    const timerHandles = setTimeoutSpy.mock.results.map(({ value }) => value)
    expect(timerHandles).toHaveLength(2)
    expect(clearTimeoutSpy.mock.calls.map(([handle]) => handle)).toEqual(
      expect.arrayContaining(timerHandles)
    )
  })

  it('skips config/batchWrite when every expected entry is already trusted', async () => {
    const keys = ['/home/a/.codex/hooks.json:session_start:0:0']
    // Why: the stub exits(9) on batchWrite in this scenario, so a write would
    // fail the session instead of silently passing.
    const { request, recordFile } = createStubRequest({
      scenario: 'reject-write',
      hooks: keys.map((key) => managedHook(key, 'trusted')),
      expectedTrustKeys: keys,
      managedCommand: MANAGED_COMMAND
    })

    const result = await runCodexHookTrustGrantSession(request)
    expect(result).toMatchObject({ outcome: 'granted', wroteTrust: false })
    expect(existsSync(recordFile)).toBe(false)
  })

  it('reports verify-failed when expected entries are missing from the listing', async () => {
    const { request } = createStubRequest({
      scenario: 'happy',
      hooks: [managedHook('/home/a/.codex/hooks.json:session_start:0:0')],
      expectedTrustKeys: [
        '/home/a/.codex/hooks.json:session_start:0:0',
        '/home/a/.codex/hooks.json:stop:0:0'
      ],
      managedCommand: MANAGED_COMMAND
    })

    const result = await runCodexHookTrustGrantSession(request)
    expect(result.outcome).toBe('verify-failed')
  })

  it('rejects duplicate normalized aliases that conceal a missing expected key', async () => {
    const aliasedKey = 'C:\\Users\\Ada\\.codex\\hooks.json:session_start:0:0'
    const { request, recordFile } = createStubRequest({
      scenario: 'happy',
      hooks: [
        managedHook(aliasedKey),
        managedHook('c:/users/ada/.codex/hooks.json:session_start:0:0')
      ],
      expectedTrustKeys: [aliasedKey, 'C:\\Users\\Ada\\.codex\\hooks.json:stop:0:0'],
      managedCommand: MANAGED_COMMAND
    })

    await expect(runCodexHookTrustGrantSession(request)).resolves.toMatchObject({
      outcome: 'verify-failed'
    })
    expect(existsSync(recordFile)).toBe(false)
  })

  it('decodes JSONL when a non-ASCII hook path is split across stdout chunks', async () => {
    const command = "/bin/sh '/tmp/rené/codex-hook.sh'"
    const key = '/home/rené/.codex/hooks.json:session_start:0:0'
    const { request } = createStubRequest({
      scenario: 'split-unicode',
      hooks: [{ ...managedHook(key), command }],
      expectedTrustKeys: [key],
      managedCommand: command,
      timeoutMs: 2_000
    })

    await expect(runCodexHookTrustGrantSession(request)).resolves.toMatchObject({
      outcome: 'granted',
      entries: [{ key }]
    })
  })

  it('throws the unsupported error class for unknown JSON-RPC methods', async () => {
    const keys = ['/home/a/.codex/hooks.json:session_start:0:0']
    const { request } = createStubRequest({
      scenario: 'unknown-method',
      hooks: keys.map((key) => managedHook(key)),
      expectedTrustKeys: keys,
      managedCommand: MANAGED_COMMAND
    })

    await expect(runCodexHookTrustGrantSession(request)).rejects.toBeInstanceOf(
      CodexAppServerUnsupportedError
    )
  })

  it('throws the unsupported error class when the CLI lacks the app-server subcommand', async () => {
    const keys = ['/home/a/.codex/hooks.json:session_start:0:0']
    const { request } = createStubRequest({
      scenario: 'no-subcommand',
      hooks: [],
      expectedTrustKeys: keys,
      managedCommand: MANAGED_COMMAND
    })

    const error = await runCodexHookTrustGrantSession(request).catch((caught: unknown) => caught)
    expect(isCodexAppServerUnsupportedError(error)).toBe(true)
  })

  it('does not classify unrelated stderr as a missing app-server capability', async () => {
    const { request } = createStubRequest({
      scenario: 'transient-stderr',
      hooks: [],
      expectedTrustKeys: ['k'],
      managedCommand: MANAGED_COMMAND
    })

    const error = await runCodexHookTrustGrantSession(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(isCodexAppServerUnsupportedError(error)).toBe(false)
  })

  it('treats a silent exit zero before initialize as transient', async () => {
    const { request } = createStubRequest({
      scenario: 'silent-exit-0',
      hooks: [],
      expectedTrustKeys: ['k'],
      managedCommand: MANAGED_COMMAND
    })

    const error = await runCodexHookTrustGrantSession(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(isCodexAppServerUnsupportedError(error)).toBe(false)
  })

  it('kills a hung server at the session deadline', async () => {
    const keys = ['/home/a/.codex/hooks.json:session_start:0:0']
    const { request, pidFile } = createStubRequest({
      scenario: 'hang',
      hooks: keys.map((key) => managedHook(key)),
      expectedTrustKeys: keys,
      managedCommand: MANAGED_COMMAND,
      timeoutMs: 500
    })

    const startedAt = Date.now()
    await expect(runCodexHookTrustGrantSession(request)).rejects.toBeInstanceOf(
      CodexAppServerTimeoutError
    )
    // Why: the reap path must not stack the grace periods on top of the
    // deadline — a wedged server may ignore everything but SIGKILL.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(childPid, 0)).toThrow()
  })

  it('bounds a callback that stalls between RPC requests', async () => {
    const { request, pidFile } = createStubRequest({
      scenario: 'happy',
      hooks: [],
      expectedTrustKeys: [],
      managedCommand: MANAGED_COMMAND,
      timeoutMs: 500
    })

    const startedAt = Date.now()
    await expect(
      runCodexAppServerSession(request.invocation, async () => new Promise<never>(() => {}))
    ).rejects.toBeInstanceOf(CodexAppServerTimeoutError)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(childPid, 0)).toThrow()
  })

  it('surfaces spawn failures as regular errors, not capability signals', async () => {
    const request: CodexHookTrustGrantRequest = {
      invocation: {
        command: join(tmpdir(), 'orca-codex-missing-binary-does-not-exist'),
        args: [],
        timeoutMs: 2_000
      },
      hooksListCwd: tmpdir(),
      expectedTrustKeys: ['k'],
      managedCommand: MANAGED_COMMAND
    }
    const error = await runCodexHookTrustGrantSession(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(isCodexAppServerUnsupportedError(error)).toBe(false)
  })
})

describe('runCodexHookTrustGrantSessionSync', () => {
  function writeEntryFixture(source: string): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-entry-'))
    tempRoots.push(root)
    const entryPath = join(root, 'grant-entry.cjs')
    writeFileSync(entryPath, source)
    return entryPath
  }

  const baseRequest: CodexHookTrustGrantRequest = {
    invocation: { command: 'codex', args: ['app-server'], timeoutMs: 1_000 },
    hooksListCwd: '/tmp',
    expectedTrustKeys: ['k'],
    managedCommand: MANAGED_COMMAND
  }

  it('returns the entry envelope result and passes the request over stdin', () => {
    const entryPath = writeEntryFixture(`
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => { input += chunk })
      process.stdin.on('end', () => {
        const request = JSON.parse(input)
        process.stdout.write(JSON.stringify({
          ok: true,
          result: {
            outcome: 'granted',
            wroteTrust: true,
            entries: [{ key: request.expectedTrustKeys[0], normalizedKey: request.expectedTrustKeys[0], trustedHash: 'sha256:x' }]
          }
        }) + '\\n')
      })
    `)
    const result = runCodexHookTrustGrantSessionSync(baseRequest, { entryPath })
    expect(result).toMatchObject({ outcome: 'granted', wroteTrust: true })
  })

  it('rethrows unsupported envelopes as the unsupported error class', () => {
    const entryPath = writeEntryFixture(`
      process.stdin.resume()
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ ok: false, errorName: 'CodexAppServerUnsupportedError', message: 'no app-server', unsupported: true }) + '\\n')
      })
    `)
    expect(() => runCodexHookTrustGrantSessionSync(baseRequest, { entryPath })).toThrow(
      CodexAppServerUnsupportedError
    )
  })

  it('fails with a clear error when the entry produces no result', () => {
    const entryPath = writeEntryFixture(
      `process.stdin.resume(); process.stdin.on('end', () => process.exit(7))`
    )
    expect(() => runCodexHookTrustGrantSessionSync(baseRequest, { entryPath })).toThrow(
      /produced no result \(exit 7\)/
    )
  })

  it('classifies the spawnSync deadline as a typed timeout', () => {
    const entryPath = writeEntryFixture(`setInterval(() => {}, 1000)`)
    const request = {
      ...baseRequest,
      invocation: { ...baseRequest.invocation, timeoutMs: 20 }
    }
    expect(() =>
      runCodexHookTrustGrantSessionSync(request, { entryPath, timeoutMarginMs: 20 })
    ).toThrow(CodexAppServerTimeoutError)
  })
})

describe('resolveCodexGrantEntryPath', () => {
  const entryName = 'codex-app-server-grant-entry.js'

  it('finds the sibling entry from emitted main and chunk directories', () => {
    const mainDir = join('/opt', 'orca', 'out', 'main')
    expect(
      resolveCodexGrantEntryPath(
        (candidate) => candidate === join(mainDir, 'codex', entryName),
        mainDir
      )
    ).toBe(join(mainDir, 'codex', entryName))

    const chunkDir = join(mainDir, 'chunks')
    expect(
      resolveCodexGrantEntryPath(
        (candidate) => candidate === join(mainDir, 'codex', entryName),
        chunkDir
      )
    ).toBe(join(mainDir, 'codex', entryName))
  })

  it('redirects app.asar to unpacked without double-unpacking an existing path', () => {
    const resourcesDir = join('/Applications', 'Orca.app', 'Contents', 'Resources')
    const expected = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'codex', entryName)
    for (const archiveDir of ['app.asar', 'app.asar.unpacked']) {
      const moduleDir = join(resourcesDir, archiveDir, 'out', 'main', 'chunks')
      expect(resolveCodexGrantEntryPath((candidate) => candidate === expected, moduleDir)).toBe(
        expected
      )
    }
  })
})
