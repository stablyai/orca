import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('../codex/codex-state-db', () => ({ isCodexStateDbBackfillPending: vi.fn(() => false) }))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn(() => Promise.resolve(null))
}))
vi.mock('./codex-auth-presence', () => ({ probeCodexAuthPresence: vi.fn(() => 'present') }))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(exitNow) })
  child.exitCode = null
  child.kill = vi.fn(() => {
    exitNow()
    return true
  })
  return child
}

/** A CLI installed under one version manager entry, with its sibling node. */
function makeVersionManagerCli(cliName = 'codex'): { bin: string; cli: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-fetch-pair-'))
  const bin = join(root, '.nvm', 'versions', 'node', 'v20.11.0', 'bin')
  mkdirSync(bin, { recursive: true })
  for (const name of ['node', 'node.exe', cliName]) {
    writeFileSync(join(bin, name), '')
    chmodSync(join(bin, name), 0o755)
  }
  return { bin, cli: join(bin, cliName) }
}

describe('codex rate-limit spawn runtime pairing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    vi.stubGlobal('fetch', vi.fn())
  })

  it("spawns the RPC reader with the resolved CLI's own node ahead of PATH", async () => {
    // Why a real fixture: the helper short-circuits on a non-absolute command,
    // so a bare 'codex' mock would make this pass vacuously.
    const { bin, cli } = makeVersionManagerCli()
    resolveCodexCommandMock.mockReturnValue(cli)
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(0)

    const spawnEnv = childSpawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
    // Guards the argument choice: pairing spawnCmd (cmd.exe on win32) rather than
    // the resolved CLI silently reverts the ABI fix (stablyai/orca#10932).
    expect(spawnEnv.PATH?.split(delimiter)[0]).toBe(bin)

    rpcChild.emit('close')
    await resultPromise
  })

  it('pairs the resolved CLI on win32, where the spawn command is cmd.exe', async () => {
    // Why win32 specifically: on posix getSpawnArgsForWindows returns the CLI
    // itself, so pairing the spawn command instead of the resolved CLI is
    // indistinguishable. Only here does the wrong argument become cmd.exe.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const { bin, cli } = makeVersionManagerCli('codex.cmd')
      resolveCodexCommandMock.mockReturnValue(cli)
      const rpcChild = makeRpcChild()
      childSpawnMock.mockReturnValue(rpcChild)

      const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
      await vi.advanceTimersByTimeAsync(0)

      const spawnCommand = childSpawnMock.mock.calls[0]?.[0] as string
      expect(spawnCommand.toLowerCase()).toContain('cmd.exe')
      const spawnEnv = childSpawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
      expect((spawnEnv.Path ?? spawnEnv.PATH)?.split(';')[0]).toBe(bin)

      rpcChild.emit('close')
      await resultPromise
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('leaves PATH alone when the CLI resolves to a bare command name', async () => {
    resolveCodexCommandMock.mockReturnValue('codex')
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(0)

    const spawnEnv = childSpawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.PATH).toBe(process.env.PATH)

    rpcChild.emit('close')
    await resultPromise
  })
})
