import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiVaultServiceTestChild,
  aiVaultServiceRequestId,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'

const forkMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

const {
  resetAiVaultScannerServiceForTests,
  resolveAiVaultSessionTitlesInService,
  setAiVaultServiceIdleTimeoutMs,
  spawnAiVaultServiceProcess
} = await import('./session-scanner-service-spawn')

function forkOptions(): { env?: NodeJS.ProcessEnv; execArgv?: string[] } {
  return forkMock.mock.calls.at(-1)?.[2] ?? {}
}

describe('spawnAiVaultServiceProcess', () => {
  beforeEach(() => {
    forkMock.mockReset()
    forkMock.mockReturnValue({ pid: undefined, unref: vi.fn() } as unknown as ChildProcess)
  })

  it('keeps NODE_OPTIONS out of the child so the heap cap and loader stand', () => {
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=8192 --require=/tmp/evil.js')
    spawnAiVaultServiceProcess()
    const options = forkOptions()

    // Omitting env inherits NODE_OPTIONS while leaving the optional-property assertion below passing.
    expect(options.env).toBeDefined()
    expect(options.env?.NODE_OPTIONS).toBeUndefined()
    expect(options.execArgv).toEqual(['--max-old-space-size=384'])
    vi.unstubAllEnvs()
  })

  it('still passes through a relocated agent home', () => {
    vi.stubEnv('CODEX_HOME', '/home/dev/elsewhere/.codex')
    spawnAiVaultServiceProcess()

    expect(forkOptions().env?.CODEX_HOME).toBe('/home/dev/elsewhere/.codex')
    vi.unstubAllEnvs()
  })

  it('runs the forked Electron binary as plain Node', () => {
    spawnAiVaultServiceProcess()

    expect(forkOptions().env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('the shared scanner client', () => {
  afterEach(() => {
    resetAiVaultScannerServiceForTests()
    vi.useRealTimers()
  })

  it('retires an idle child after the timeout an orcad host configured', async () => {
    vi.useFakeTimers()
    const child = new AiVaultServiceTestChild(4242)
    forkMock.mockReset()
    forkMock.mockReturnValue(child.asChildProcess())
    setAiVaultServiceIdleTimeoutMs(60_000)

    const titles = resolveAiVaultSessionTitlesInService([])
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    child.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(child, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    await titles

    vi.advanceTimersByTime(59_999)
    expect(child.sent).not.toContainEqual({ type: 'shutdown' })
    vi.advanceTimersByTime(1)
    expect(child.sent).toContainEqual({ type: 'shutdown' })
  })
})
