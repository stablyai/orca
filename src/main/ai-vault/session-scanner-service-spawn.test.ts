import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const forkMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

const { spawnAiVaultServiceProcess, stampDiscoverySpanAttributes } =
  await import('./session-scanner-service-spawn')

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

    // Asserted first: omitting `env` entirely inherits everything, and would
    // leave the NODE_OPTIONS assertion below passing for the wrong reason.
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

  it('widens the libuv threadpool so local fs.stat/readdir discovery is not 4-wide serialized', () => {
    spawnAiVaultServiceProcess()
    expect(forkOptions().env?.UV_THREADPOOL_SIZE).toBe('16')
  })
})

// The forked child has no tracer sink; this is the one place discovery cost becomes visible.
describe('stampDiscoverySpanAttributes', () => {
  function fakeSpan(): {
    attrs: Map<string, unknown>
    setAttribute: (k: string, v: unknown) => void
  } {
    const attrs = new Map<string, unknown>()
    return { attrs, setAttribute: (k, v) => attrs.set(k, v) }
  }

  it('separates UNC roots from local roots and rounds elapsed times', () => {
    const span = fakeSpan()
    stampDiscoverySpanAttributes(span as never, {
      totalMs: 240_123.7,
      roots: [
        {
          agent: 'claude',
          rootDir: '/home/ada/.claude/projects',
          isUncPath: false,
          elapsedMs: 5.2,
          fileCount: 3,
          errored: false
        },
        {
          agent: 'codex',
          rootDir: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions',
          isUncPath: true,
          elapsedMs: 120_000.4,
          fileCount: 0,
          errored: true
        },
        {
          agent: 'gemini',
          rootDir: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.gemini',
          isUncPath: true,
          elapsedMs: 119_998.9,
          fileCount: 0,
          errored: true
        }
      ]
    })

    expect(span.attrs.get('discoveryMs')).toBe(240_124)
    expect(span.attrs.get('discoveryRootCount')).toBe(3)
    expect(span.attrs.get('discoveryUncRootCount')).toBe(2)
    expect(span.attrs.get('discoveryUncElapsedMs')).toBe(239_999)
    expect(span.attrs.get('discoveryErroredRootCount')).toBe(2)
  })

  it('reports zero counts for an all-local, all-healthy scan', () => {
    const span = fakeSpan()
    stampDiscoverySpanAttributes(span as never, {
      totalMs: 800,
      roots: [
        {
          agent: 'claude',
          rootDir: '/home/ada/.claude/projects',
          isUncPath: false,
          elapsedMs: 800,
          fileCount: 12,
          errored: false
        }
      ]
    })

    expect(span.attrs.get('discoveryUncRootCount')).toBe(0)
    expect(span.attrs.get('discoveryUncElapsedMs')).toBe(0)
    expect(span.attrs.get('discoveryErroredRootCount')).toBe(0)
  })
})
