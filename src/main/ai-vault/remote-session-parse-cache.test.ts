import { beforeEach, describe, expect, it } from 'vitest'
import type { FileReadResult } from '../providers/types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { resetRemoteSessionParseCacheForTests } from './remote-session-parse-cache'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'

/**
 * Counts whole-transcript reads, which is the cost #13753 is about. Codex's
 * per-scan `session_index.jsonl` title lookup is one small file and is not part
 * of the corpus term, so it is excluded rather than asserted on.
 */
class CountingRemoteProvider extends MemoryRemoteProvider {
  readonly readFilePaths: string[] = []

  override async readFile(filePath: string): Promise<FileReadResult> {
    if (filePath.includes('/sessions/')) {
      this.readFilePaths.push(filePath)
    }
    return await super.readFile(filePath)
  }
}

function transcript(sessionId: string, title: string, timestamp: string): string {
  return jsonLines([
    {
      timestamp,
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/home/ada/repo' }
    },
    {
      timestamp,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: title }] }
    }
  ])
}

function scan(provider: CountingRemoteProvider): ReturnType<typeof scanRemoteAiVaultSessions> {
  return scanRemoteAiVaultSessions({
    provider,
    executionHostId: 'ssh:dev-box',
    remoteHome: '/home/ada',
    hostPlatform: getRemoteHostPlatform('linux-x64')
  })
}

describe('remote AI Vault transcript re-reads', () => {
  beforeEach(() => {
    resetRemoteSessionParseCacheForTests()
  })

  it('does not re-read an unchanged corpus on the next scan', async () => {
    const provider = new CountingRemoteProvider()
    for (const day of ['07/07', '07/25', '08/10']) {
      provider.addFile(
        `/home/ada/.codex/sessions/2026/${day}/rollout-${day.replace('/', '')}.jsonl`,
        transcript(
          `session-${day.replace('/', '')}`,
          `Work from ${day}`,
          '2026-07-07T01:00:00.000Z'
        ),
        1_000
      )
    }

    const first = await scan(provider)
    expect(first.sessions).toHaveLength(3)
    expect(provider.readFilePaths).toHaveLength(3)

    provider.readFilePaths.length = 0
    const second = await scan(provider)

    // Historical transcripts are immutable; a second pass must cost zero reads.
    expect(provider.readFilePaths).toEqual([])
    expect(second.sessions.map((session) => session.title)).toEqual(
      first.sessions.map((session) => session.title)
    )
  })

  it('re-reads a transcript that actually changed', async () => {
    const provider = new CountingRemoteProvider()
    const path = '/home/ada/.codex/sessions/2026/08/31/rollout-live.jsonl'
    provider.addFile(
      path,
      transcript('live-session', 'First prompt', '2026-08-31T01:00:00.000Z'),
      1_000
    )

    await scan(provider)
    provider.readFilePaths.length = 0

    provider.addFile(
      path,
      transcript('live-session', 'Second prompt', '2026-08-31T02:00:00.000Z'),
      2_000
    )
    const result = await scan(provider)

    expect(provider.readFilePaths).toEqual([path])
    expect(result.sessions[0]?.title).toBe('Second prompt')
  })

  it('re-reads when only the size changed under an unchanged mtime', async () => {
    const provider = new CountingRemoteProvider()
    const path = '/home/ada/.codex/sessions/2026/08/31/rollout-grown.jsonl'
    provider.addFile(path, transcript('grown-session', 'Short', '2026-08-31T01:00:00.000Z'), 1_000)

    await scan(provider)
    provider.readFilePaths.length = 0

    provider.addFile(
      path,
      transcript(
        'grown-session',
        'A much longer first prompt than before',
        '2026-08-31T01:00:00.000Z'
      ),
      1_000
    )
    const result = await scan(provider)

    expect(provider.readFilePaths).toEqual([path])
    expect(result.sessions[0]?.title).toBe('A much longer first prompt than before')
  })

  // Codex names threads in $CODEX_HOME/session_index.jsonl asynchronously, after
  // the rollout's last append — so the transcript's mtime+size never changes to
  // signal it. That file sits outside `sessions/`, hence outside the read count.
  it('picks up a session_index title written after the transcript was cached', async () => {
    const provider = new CountingRemoteProvider()
    const path = '/home/ada/.codex/sessions/2026/08/31/rollout-named-later.jsonl'
    provider.addFile(
      path,
      transcript('named-later-session', 'First prompt', '2026-08-31T01:00:00.000Z'),
      1_000
    )
    provider.addFile(
      '/home/ada/.codex/session_index.jsonl',
      jsonLines([{ id: 'some-other-session', thread_name: 'Unrelated thread' }]),
      1_000
    )

    const first = await scan(provider)
    expect(first.sessions[0]?.title).toBe('First prompt')

    provider.readFilePaths.length = 0
    provider.addFile(
      '/home/ada/.codex/session_index.jsonl',
      jsonLines([
        { id: 'some-other-session', thread_name: 'Unrelated thread' },
        { id: 'named-later-session', thread_name: 'Named by Codex after the fact' }
      ]),
      2_000
    )
    const second = await scan(provider)

    expect(second.sessions[0]?.title).toBe('Named by Codex after the fact')
    // The #13753 win is preserved: the index is read, the transcript is not.
    expect(provider.readFilePaths).toEqual([])
  })

  it('does not serve a cached parse to a different execution host', async () => {
    const provider = new CountingRemoteProvider()
    const path = '/home/ada/.codex/sessions/2026/08/31/rollout-host.jsonl'
    provider.addFile(
      path,
      transcript('host-session', 'Host scoped', '2026-08-31T01:00:00.000Z'),
      1_000
    )

    await scan(provider)
    provider.readFilePaths.length = 0

    const other = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:other-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(provider.readFilePaths).toEqual([path])
    expect(other.sessions[0]?.executionHostId).toBe('ssh:other-box')
  })

  it('does not cache a read that failed', async () => {
    const provider = new CountingRemoteProvider()
    const path = '/home/ada/.codex/sessions/2026/08/31/rollout-flaky.jsonl'
    provider.addFile(
      path,
      transcript('flaky-session', 'Recovered', '2026-08-31T01:00:00.000Z'),
      1_000
    )

    let failNextRead = true
    const originalReadFile = provider.readFile.bind(provider)
    provider.readFile = async (filePath: string): Promise<FileReadResult> => {
      if (failNextRead && filePath === path) {
        failNextRead = false
        provider.readFilePaths.push(filePath)
        throw new Error('EIO: transient relay read failure')
      }
      return await originalReadFile(filePath)
    }

    const failed = await scan(provider)
    expect(failed.sessions).toEqual([])
    expect(failed.issues).toHaveLength(1)

    provider.readFilePaths.length = 0
    const recovered = await scan(provider)

    expect(provider.readFilePaths).toEqual([path])
    expect(recovered.sessions[0]?.title).toBe('Recovered')
  })
})
