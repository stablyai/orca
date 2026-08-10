import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveNativeChatSshOwner = vi.fn()
const readSshNativeChatTranscript = vi.fn()
const subscribeSshNativeChatTranscript = vi.fn()
const readNativeChatTranscriptTail = vi.fn()
const subscribeNativeChatTranscript = vi.fn()

vi.mock('./ssh-transcript-host', () => ({
  resolveNativeChatSshOwner: (...args: unknown[]) => resolveNativeChatSshOwner(...args),
  readSshNativeChatTranscript: (...args: unknown[]) => readSshNativeChatTranscript(...args)
}))

vi.mock('./ssh-transcript-subscription', () => ({
  subscribeSshNativeChatTranscript: (...args: unknown[]) => subscribeSshNativeChatTranscript(...args)
}))

vi.mock('./transcript-watch', () => ({
  readNativeChatTranscriptTail: (...args: unknown[]) => readNativeChatTranscriptTail(...args),
  subscribeNativeChatTranscript: (...args: unknown[]) => subscribeNativeChatTranscript(...args)
}))

const { readRoutedNativeChatTranscriptTail, subscribeRoutedNativeChatTranscript } = await import(
  './transcript-source-routing'
)

const localResult = { messages: [], hasMore: false, beforeOffset: 0 }
const MISS = { error: 'Transcript unavailable', notFound: true }

beforeEach(() => {
  vi.clearAllMocks()
  readNativeChatTranscriptTail.mockResolvedValue(localResult)
  subscribeNativeChatTranscript.mockResolvedValue({ watching: true, unsubscribe: () => {} })
  subscribeSshNativeChatTranscript.mockReturnValue({ watching: true, unsubscribe: () => {} })
})

describe('readRoutedNativeChatTranscriptTail', () => {
  it('reads an SSH session on the host that owns the file', async () => {
    resolveNativeChatSshOwner.mockReturnValue({ connectionId: 'dev-box' })
    readSshNativeChatTranscript.mockResolvedValue({
      messages: [],
      hasMore: false,
      beforeOffset: 0,
      fileSize: 10
    })

    await readRoutedNativeChatTranscriptTail({ agent: 'claude', sessionId: 'abc', limit: 40 })

    expect(readSshNativeChatTranscript).toHaveBeenCalledTimes(1)
    expect(readNativeChatTranscriptTail).not.toHaveBeenCalled()
  })

  it('forwards the hook path, never a client-supplied one', async () => {
    resolveNativeChatSshOwner.mockReturnValue({
      connectionId: 'dev-box',
      transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl'
    })
    readSshNativeChatTranscript.mockResolvedValue({
      messages: [],
      hasMore: false,
      beforeOffset: 0,
      fileSize: 10
    })

    await readRoutedNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'abc',
      transcriptPath: '/etc/anything/else.jsonl',
      limit: 40
    })

    expect(readSshNativeChatTranscript).toHaveBeenCalledWith(
      'dev-box',
      expect.objectContaining({ transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl' }),
      undefined
    )
  })

  it('keeps a local session on the local reader', async () => {
    resolveNativeChatSshOwner.mockReturnValue(null)

    await readRoutedNativeChatTranscriptTail({ agent: 'claude', sessionId: 'abc', limit: 40 })

    expect(readSshNativeChatTranscript).not.toHaveBeenCalled()
    expect(readNativeChatTranscriptTail).toHaveBeenCalledTimes(1)
  })

  it('reports a miss rather than reading a local look-alike when the relay cannot answer', async () => {
    resolveNativeChatSshOwner.mockReturnValue({ connectionId: 'dev-box' })
    readSshNativeChatTranscript.mockResolvedValue(null)

    await expect(
      readRoutedNativeChatTranscriptTail({ agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toEqual(MISS)
    expect(readNativeChatTranscriptTail).not.toHaveBeenCalled()
  })

  it('reports a miss when the relay leg fails', async () => {
    resolveNativeChatSshOwner.mockReturnValue({ connectionId: 'dev-box' })
    readSshNativeChatTranscript.mockRejectedValue(new Error('SSH relay is not ready'))

    await expect(
      readRoutedNativeChatTranscriptTail({ agent: 'claude', sessionId: 'abc', limit: 40 })
    ).resolves.toEqual(MISS)
    expect(readNativeChatTranscriptTail).not.toHaveBeenCalled()
  })

  it('propagates a cancelled read instead of turning it into a miss', async () => {
    resolveNativeChatSshOwner.mockReturnValue({ connectionId: 'dev-box' })
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    readSshNativeChatTranscript.mockRejectedValue(aborted)

    await expect(
      readRoutedNativeChatTranscriptTail({ agent: 'claude', sessionId: 'abc', limit: 40 })
    ).rejects.toThrow('aborted')
  })

  it('never routes an already-resolved local file path to a relay', async () => {
    resolveNativeChatSshOwner.mockReturnValue({ connectionId: 'dev-box' })

    await readRoutedNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'abc',
      limit: 40,
      filePath: '/tmp/transcript.jsonl'
    })

    expect(readSshNativeChatTranscript).not.toHaveBeenCalled()
    expect(readNativeChatTranscriptTail).toHaveBeenCalledTimes(1)
  })
})

describe('subscribeRoutedNativeChatTranscript', () => {
  it('polls the relay for an SSH session', async () => {
    resolveNativeChatSshOwner.mockReturnValue({ connectionId: 'dev-box' })

    await subscribeRoutedNativeChatTranscript({
      agent: 'claude',
      sessionId: 'abc',
      onAppend: () => {}
    })

    expect(subscribeSshNativeChatTranscript).toHaveBeenCalledTimes(1)
    expect(subscribeNativeChatTranscript).not.toHaveBeenCalled()
  })

  it('watches the local file for a local session', async () => {
    resolveNativeChatSshOwner.mockReturnValue(null)

    await subscribeRoutedNativeChatTranscript({
      agent: 'claude',
      sessionId: 'abc',
      onAppend: () => {}
    })

    expect(subscribeNativeChatTranscript).toHaveBeenCalledTimes(1)
    expect(subscribeSshNativeChatTranscript).not.toHaveBeenCalled()
  })

  it('fails fast for an agent whose transcript this view cannot decode', async () => {
    resolveNativeChatSshOwner.mockReturnValue({ connectionId: 'dev-box' })

    const subscription = await subscribeRoutedNativeChatTranscript({
      agent: 'devin',
      sessionId: 'abc',
      onAppend: () => {}
    })

    expect(subscription.watching).toBe(false)
    expect(subscribeSshNativeChatTranscript).not.toHaveBeenCalled()
  })

  it('fails fast for a blank session id, which can never resolve', async () => {
    resolveNativeChatSshOwner.mockReturnValue({ connectionId: 'dev-box' })

    const subscription = await subscribeRoutedNativeChatTranscript({
      agent: 'claude',
      sessionId: '   ',
      onAppend: () => {}
    })

    expect(subscription.watching).toBe(false)
    expect(subscribeSshNativeChatTranscript).not.toHaveBeenCalled()
  })
})
