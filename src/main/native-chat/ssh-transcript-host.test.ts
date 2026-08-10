import { beforeEach, describe, expect, it, vi } from 'vitest'

const getStatusSnapshot = vi.fn()
const relayRead = vi.fn()
const getSshNativeChatTranscriptReader = vi.fn()

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    getStatusSnapshot: (...args: unknown[]) => getStatusSnapshot(...args)
  }
}))

vi.mock('./ssh-transcript-dispatch', () => ({
  getSshNativeChatTranscriptReader: (...args: unknown[]) =>
    getSshNativeChatTranscriptReader(...args)
}))

const { readSshNativeChatTranscript, resolveNativeChatSshOwner } = await import(
  './ssh-transcript-host'
)

function hookRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    paneKey: 'pane-1',
    state: 'working',
    prompt: '',
    connectionId: null,
    receivedAt: 0,
    stateStartedAt: 0,
    ...overrides
  }
}

const remoteMessage = {
  id: 'assistant-1',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'hi' }],
  timestamp: null,
  source: 'transcript'
}

describe('resolveNativeChatSshOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finds the SSH host that owns the session', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({ connectionId: null, providerSession: { key: 'session_id', id: 'local-session' } }),
      hookRow({ connectionId: 'dev-box', providerSession: { key: 'session_id', id: 'abc' } })
    ])

    expect(resolveNativeChatSshOwner({ sessionId: 'abc' })).toEqual({ connectionId: 'dev-box' })
  })

  it('returns the hook path so a client-supplied path is never forwarded', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({
        connectionId: 'dev-box',
        providerSession: {
          key: 'session_id',
          id: 'abc',
          transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl'
        }
      })
    ])

    expect(
      resolveNativeChatSshOwner({ sessionId: 'abc', transcriptPath: '/etc/somewhere/else.jsonl' })
    ).toEqual({ connectionId: 'dev-box', transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl' })
  })

  it('prefers an exact path match over an earlier row that only matches by id', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({ connectionId: 'other-box', providerSession: { key: 'session_id', id: 'shared' } }),
      hookRow({
        connectionId: 'dev-box',
        providerSession: {
          key: 'session_id',
          id: 'hook-session-id',
          transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl'
        }
      })
    ])

    expect(
      resolveNativeChatSshOwner({
        sessionId: 'shared',
        transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl'
      })
    ).toMatchObject({ connectionId: 'dev-box' })
  })

  it('treats a WSL guest as local, because the host can open it through the UNC twin', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({
        connectionId: 'wsl:Ubuntu',
        providerSession: {
          key: 'session_id',
          id: 'abc',
          transcriptPath: '/home/ada/.claude/projects/repo/file.jsonl'
        }
      })
    ])

    expect(resolveNativeChatSshOwner({ sessionId: 'abc' })).toBeNull()
  })

  it('leaves a local session on the local reader', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({ connectionId: null, providerSession: { key: 'session_id', id: 'abc' } })
    ])

    expect(resolveNativeChatSshOwner({ sessionId: 'abc' })).toBeNull()
  })

  it('does not claim a session no hook row knows about', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({ connectionId: 'dev-box', providerSession: { key: 'session_id', id: 'other' } })
    ])

    expect(resolveNativeChatSshOwner({ sessionId: 'abc' })).toBeNull()
  })
})

describe('readSshNativeChatTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSshNativeChatTranscriptReader.mockReturnValue(relayRead)
  })

  it('returns null when this target has no live relay, so the caller can fall back', async () => {
    getSshNativeChatTranscriptReader.mockReturnValue(undefined)

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toBeNull()
  })

  it('returns the relay window', async () => {
    relayRead.mockResolvedValue({
      messages: [remoteMessage],
      hasMore: false,
      beforeOffset: 0,
      fileSize: 120,
      filePath: '/home/dev/.claude/projects/repo/file.jsonl'
    })

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toMatchObject({ messages: [{ id: 'assistant-1' }], fileSize: 120 })
  })

  it('accepts an append delta', async () => {
    relayRead.mockResolvedValue({ appended: [remoteMessage], fileSize: 200 })

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toMatchObject({ appended: [{ id: 'assistant-1' }], fileSize: 200 })
  })

  it('returns null when the deployed relay predates the method, so the caller can fall back', async () => {
    relayRead.mockResolvedValue(null)

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toBeNull()
  })

  it('treats an unparseable payload as a retry-worthy miss instead of rendering junk', async () => {
    relayRead.mockResolvedValue({ messages: 'not-an-array' })

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toEqual({ error: 'Transcript unavailable', notFound: true })
  })

  it('forwards the poll cursor so an unchanged transcript costs one stat', async () => {
    relayRead.mockResolvedValue({ unchanged: true, fileSize: 120 })

    await readSshNativeChatTranscript('dev-box', {
      agent: 'claude',
      sessionId: 'abc',
      limit: 40,
      knownFileSize: 120
    })

    expect(relayRead).toHaveBeenCalledWith(
      expect.objectContaining({ knownFileSize: 120, limit: 40 }),
      expect.anything()
    )
  })
})
