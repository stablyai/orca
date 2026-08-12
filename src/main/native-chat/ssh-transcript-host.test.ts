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

  it('prefers an exact path match over an earlier same-session row that only matches by id', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({ connectionId: 'other-box', providerSession: { key: 'session_id', id: 'shared' } }),
      hookRow({
        connectionId: 'dev-box',
        providerSession: {
          key: 'session_id',
          id: 'shared',
          transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl'
        }
      })
    ])

    expect(
      resolveNativeChatSshOwner({
        sessionId: 'shared',
        transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl'
      })
    ).toEqual({
      connectionId: 'dev-box',
      transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl'
    })
  })

  it('does not route session A to another session via a client-supplied path', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({
        connectionId: 'box-a',
        providerSession: { key: 'session_id', id: 'session-a' }
      }),
      hookRow({
        connectionId: 'box-b',
        providerSession: {
          key: 'session_id',
          id: 'session-b',
          transcriptPath: '/home/dev/.claude/projects/repo/session-b.jsonl'
        }
      })
    ])

    expect(
      resolveNativeChatSshOwner({
        sessionId: 'session-a',
        transcriptPath: '/home/dev/.claude/projects/repo/session-b.jsonl'
      })
    ).toEqual({ connectionId: 'box-a' })
  })

  it('ignores a path-only match when the session id is for a different remote row', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({
        connectionId: 'box-b',
        providerSession: {
          key: 'session_id',
          id: 'session-b',
          transcriptPath: '/home/dev/.claude/projects/repo/session-b.jsonl'
        }
      })
    ])

    expect(
      resolveNativeChatSshOwner({
        sessionId: 'session-a',
        transcriptPath: '/home/dev/.claude/projects/repo/session-b.jsonl'
      })
    ).toBeNull()
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

  it('picks the freshest row when two connections report the same session id', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({
        connectionId: 'stale-box',
        receivedAt: 100,
        providerSession: { key: 'session_id', id: 'abc' }
      }),
      hookRow({
        connectionId: 'live-box',
        receivedAt: 500,
        providerSession: { key: 'session_id', id: 'abc' }
      })
    ])

    expect(resolveNativeChatSshOwner({ sessionId: 'abc' })).toMatchObject({
      connectionId: 'live-box'
    })
  })

  it('picks the freshest same-session row when two hosts report the same transcript path', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({
        connectionId: 'stale-box',
        receivedAt: 100,
        providerSession: { key: 'session_id', id: 'abc', transcriptPath: '/home/dev/t.jsonl' }
      }),
      hookRow({
        connectionId: 'live-box',
        receivedAt: 900,
        providerSession: { key: 'session_id', id: 'abc', transcriptPath: '/home/dev/t.jsonl' }
      })
    ])

    expect(
      resolveNativeChatSshOwner({ sessionId: 'abc', transcriptPath: '/home/dev/t.jsonl' })
    ).toEqual({ connectionId: 'live-box', transcriptPath: '/home/dev/t.jsonl' })
  })

  it('returns null without a session id even when a path matches a hook row', () => {
    getStatusSnapshot.mockReturnValue([
      hookRow({
        connectionId: 'dev-box',
        providerSession: {
          key: 'session_id',
          id: 'abc',
          transcriptPath: '/home/dev/t.jsonl'
        }
      })
    ])

    expect(resolveNativeChatSshOwner({ sessionId: '', transcriptPath: '/home/dev/t.jsonl' })).toBeNull()
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
    relayRead.mockResolvedValue({
      appended: [remoteMessage],
      fileSize: 200,
      generation: '4:5:6'
    })

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toMatchObject({
      appended: [{ id: 'assistant-1' }],
      fileSize: 200,
      generation: '4:5:6'
    })
  })

  it('accepts a relay that reports no generation, so an older one still works', async () => {
    relayRead.mockResolvedValue({ unchanged: true, fileSize: 120 })

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toEqual({ unchanged: true, fileSize: 120 })
  })

  it('returns null when the deployed relay predates the method, so the caller can fall back', async () => {
    relayRead.mockResolvedValue(null)

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toBeNull()
  })

  it('reports an unparseable payload as a real error, not as a not-yet-written transcript', async () => {
    // `notFound` means "the agent has not flushed it yet" and makes the poll loop
    // wait silently, so a broken relay must not borrow that shape.
    relayRead.mockResolvedValue({ messages: 'not-an-array' })

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toEqual({ error: 'Transcript unavailable' })
  })

  it('passes a genuinely absent transcript through as notFound', async () => {
    relayRead.mockResolvedValue({ error: 'Transcript unavailable', notFound: true })

    await expect(
      readSshNativeChatTranscript('dev-box', { agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toEqual({ error: 'Transcript unavailable', notFound: true })
  })

  it('forwards the file generation so a same-length replacement is still detected', async () => {
    relayRead.mockResolvedValue({ unchanged: true, fileSize: 120, generation: '1:2:3' })

    // The envelope must keep `generation` on the way back too: a schema that
    // strips it silently degrades the cursor to size-only.
    await expect(
      readSshNativeChatTranscript('dev-box', {
        agent: 'claude',
        sessionId: 'abc',
        limit: 40,
        knownFileSize: 120,
        generation: '1:2:3'
      })
    ).resolves.toEqual({ unchanged: true, fileSize: 120, generation: '1:2:3' })

    expect(relayRead).toHaveBeenCalledWith(
      expect.objectContaining({ generation: '1:2:3' }),
      expect.anything()
    )
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
