import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type * as NodePathModule from 'node:path'
import type { SessionFileCandidate } from './session-scanner-types'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  open: mocks.open,
  readFile: mocks.readFile,
  readdir: mocks.readdir,
  stat: mocks.stat
}))

// Derived sibling paths must retain Windows separators in this cross-platform test.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePathModule>()
  return { ...actual.win32, default: actual.win32 }
})

import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import {
  resetWslTranscriptFsGateForTests,
  WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS,
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS,
  WslTranscriptFsError
} from '../native-chat/wsl-transcript-fs-gate'

function uncPath(distro: string, ...segments: string[]): string {
  return `\\\\wsl.localhost\\${distro}\\home\\ada\\${segments.join('\\')}`
}

const KIMI_HOME = ['.kimi-code', 'sessions', 'wd_app_9f2', 'session_abc']
const GROK_DIR = ['.grok', 'sessions', 'ses-1']
const OPENCODE_ROOT = ['.local', 'share', 'opencode', 'storage']

const KIMI_STATE = JSON.stringify({
  title: 'Kimi session',
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:05:00.000Z',
  agents: { main: { type: 'main', parentAgentId: null } }
})

const KIMI_WIRE = `${JSON.stringify({
  type: 'context.append_message',
  message: { role: 'user', origin: { kind: 'user' }, content: 'ship it' }
})}\n`

const GROK_SESSION = JSON.stringify({
  info: { id: 'ses-1', cwd: '/repo/app' },
  generated_title: 'Grok session',
  created_at: '2026-06-01T10:00:00.000Z'
})

const GROK_HISTORY = `${JSON.stringify({
  type: 'user',
  content: '<user_query>ship it</user_query>'
})}\n`

const OPENCODE_SESSION = JSON.stringify({
  id: 'ses-1',
  title: 'OpenCode session',
  directory: '/repo/app',
  time: { created: 1780000000000 }
})

const OPENCODE_MESSAGE = JSON.stringify({
  role: 'user',
  content: [{ type: 'text', text: 'ship it' }],
  time: { created: 1780000000000 }
})

type ReadResult = { bytesRead: number; buffer: Buffer }

let releaseStall: (() => void) | undefined

function stalls<T>(): Promise<T> {
  return new Promise<T>((resolve) => {
    releaseStall = () => resolve({ bytesRead: 0, buffer: Buffer.alloc(0) } as T)
  })
}

function stallingHandle() {
  return { read: vi.fn(stalls<ReadResult>), close: vi.fn(async () => {}) }
}

function servingHandle(body: string) {
  const bytes = Buffer.from(body)
  return {
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const slice = bytes.subarray(position, Math.min(position + length, bytes.length))
      slice.copy(buffer, offset)
      return { bytesRead: slice.length, buffer }
    }),
    close: vi.fn(async () => {})
  }
}

function missing(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

// Complete: UNC readdir results pass through the child dispatcher's dirent
// serializer, which reads every kind flag.
function dirent(name: string) {
  return {
    name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    isFIFO: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false
  }
}

function candidate(agent: SessionFileCandidate['agent'], path: string): SessionFileCandidate {
  return {
    agent,
    file: {
      path,
      mtimeMs: 1,
      modifiedAt: '2026-06-01T10:05:00.000Z',
      sizeBytes: 128
    },
    codexHome: null
  }
}

async function expectRefusal(target: SessionFileCandidate): Promise<void> {
  const refusal = expect(parseAgentSessionFileCached(target, 'linux')).rejects.toBeInstanceOf(
    WslTranscriptFsError
  )
  await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS + 1)
  await refusal
}

// A result that lands past the deadline never lifts the route quarantine, so
// recovery waits out the back-off window the same way production does.
async function releaseAndSettle(): Promise<void> {
  releaseStall?.()
  releaseStall = undefined
  await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
}

beforeEach(() => {
  // blockedRoutes is persistent gate state: a prior stall must not quarantine
  // this test's route.
  resetWslTranscriptFsGateForTests()
  resetSessionParseCacheForTests()
  mocks.open.mockReset()
  mocks.readFile.mockReset()
  mocks.readdir.mockReset()
  mocks.stat.mockReset()
  releaseStall = undefined
  mocks.stat.mockRejectedValue(missing())
  // performance.now drives the route quarantine clock, so it must be faked too.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
})

afterEach(async () => {
  await releaseAndSettle()
  vi.useRealTimers()
})

describe('Kimi session parse against a stalled WSL transcript', () => {
  it('refuses a stalled state.json read instead of reporting no session', async () => {
    const state = uncPath('KimiState', ...KIMI_HOME, 'state.json')
    mocks.readFile.mockImplementation(stalls<string>)

    await expectRefusal(candidate('kimi', state))
  })

  it('refuses a stalled wire read, then caches the full session once it recovers', async () => {
    const state = uncPath('KimiWire', ...KIMI_HOME, 'state.json')
    mocks.readFile.mockResolvedValue(KIMI_STATE)
    mocks.open.mockResolvedValue(stallingHandle())

    await expectRefusal(candidate('kimi', state))
    await releaseAndSettle()

    mocks.open.mockResolvedValue(servingHandle(KIMI_WIRE))
    const recovered = await parseAgentSessionFileCached(candidate('kimi', state), 'linux')

    expect(recovered?.messageCount).toBe(1)
  })

  // Pins the narrowness of the parser's `instanceof WslTranscriptFsError`
  // rethrow: widening it to every error turns this into a hard scan issue.
  it('still returns a metadata-only session when the wire file is simply missing', async () => {
    const state = uncPath('KimiMissing', ...KIMI_HOME, 'state.json')
    mocks.readFile.mockResolvedValue(KIMI_STATE)
    mocks.open.mockRejectedValue(missing())

    const session = await parseAgentSessionFileCached(candidate('kimi', state), 'linux')

    expect(session).toMatchObject({ agent: 'kimi', title: 'Kimi session', messageCount: 0 })
  })
})

describe('Grok session parse against a stalled WSL transcript', () => {
  it('refuses a stalled chat_history read instead of reporting a summary-only session', async () => {
    const file = uncPath('GrokHistory', ...GROK_DIR, 'session.json')
    mocks.readFile.mockResolvedValue(GROK_SESSION)
    mocks.open.mockResolvedValue(stallingHandle())

    await expectRefusal(candidate('grok', file))
    await releaseAndSettle()

    mocks.open.mockResolvedValue(servingHandle(GROK_HISTORY))
    const recovered = await parseAgentSessionFileCached(candidate('grok', file), 'linux')

    expect(recovered?.previewMessages).toEqual([
      expect.objectContaining({ role: 'user', text: 'ship it' })
    ])
  })

  it('still returns the summary-only session when chat_history is missing', async () => {
    const file = uncPath('GrokMissing', ...GROK_DIR, 'session.json')
    mocks.readFile.mockResolvedValue(GROK_SESSION)
    mocks.open.mockRejectedValue(missing())

    const session = await parseAgentSessionFileCached(candidate('grok', file), 'linux')

    expect(session).toMatchObject({
      agent: 'grok',
      title: 'Grok session',
      previewMessages: []
    })
  })
})

describe('OpenCode session parse against a stalled WSL transcript', () => {
  function sessionPath(distro: string): string {
    return uncPath(distro, ...OPENCODE_ROOT, 'session', 'prj', 'ses-1.json')
  }

  it('refuses a stalled message-directory listing instead of an empty transcript', async () => {
    mocks.readFile.mockResolvedValue(OPENCODE_SESSION)
    mocks.readdir.mockImplementation(stalls<unknown[]>)

    await expectRefusal(candidate('opencode', sessionPath('OpenCodeDir')))
  })

  it('refuses a stalled per-message read instead of a partial transcript', async () => {
    const file = sessionPath('OpenCodeMessage')
    mocks.readdir.mockResolvedValue([dirent('msg-1.json')])
    mocks.readFile.mockImplementation((path: string) =>
      path === file ? Promise.resolve(OPENCODE_SESSION) : stalls<string>()
    )

    await expectRefusal(candidate('opencode', file))
    await releaseAndSettle()

    mocks.readFile.mockImplementation((path: string) =>
      Promise.resolve(path === file ? OPENCODE_SESSION : OPENCODE_MESSAGE)
    )
    const recovered = await parseAgentSessionFileCached(candidate('opencode', file), 'linux')

    expect(recovered?.messageCount).toBe(1)
  })

  // Same guard as Kimi's: a live process mid-write must stay a parseable
  // session, not a refusal.
  it('still returns the session when a live process left a half-written message', async () => {
    const file = sessionPath('OpenCodeHalfWritten')
    mocks.readdir.mockResolvedValue([dirent('msg-1.json')])
    mocks.readFile.mockImplementation((path: string) =>
      Promise.resolve(path === file ? OPENCODE_SESSION : '{"role":"user",')
    )

    const session = await parseAgentSessionFileCached(candidate('opencode', file), 'linux')

    expect(session).toMatchObject({ agent: 'opencode', title: 'OpenCode session', messageCount: 0 })
  })
})
