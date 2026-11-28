import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { nativeChatScratchFolderName } from '../../../native-chat/conversation-files/native-chat-scratch-folder'

const SPAWNED_AT = 1_800_000_000_000
const relayedRun = (sessionId: string) => ({
  sessionId,
  lastRunPlacement: {
    fence: 3,
    kind: 'relayed',
    relayId: `r-${sessionId}`,
    daemon: { instance: 'daemon-start', pid: 4242, startedAtMs: 1 },
    agent: { hostId: 'local', pid: 4243, processStartTimeMs: SPAWNED_AT, spawnToken: 't' }
  }
})
// Its daemon can't say yet whether the kept chat's run still goes: that alone keeps its files.
vi.mock('../../../provider-relay/app-provider-relays', () => ({
  providerRelayRunLiveness: async ({ sessionId }: { sessionId: string }) =>
    sessionId === 'kept-chat' ? 'unknown' : 'gone'
}))
vi.mock('../../../provider-relay/provider-relay-route', () => ({ providerRelayRoute: () => ({}) }))
vi.mock('../../../runtime/agent-session/records/agent-session-record-store-slot', () => ({
  peekOpenedAgentSessionRecordStore: () => ({
    listRecords: () => [relayedRun('kept-chat'), relayedRun('gone-chat')]
  })
}))

const { clearEarlierRunsOnce } = await import('../acp-instructions-earlier-runs')

describe('clearing earlier runs’ instruction folders', () => {
  it('keeps every folder of a chat whose relayed run may still go, and drops the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-instructions-'))
    const kept = nativeChatScratchFolderName('kept-chat')
    const gone = nativeChatScratchFolderName('gone-chat')
    const folders: [string, number][] = [
      [`${kept}-old`, SPAWNED_AT - 60_000],
      [`${kept}-agent`, SPAWNED_AT - 500],
      [`${kept}-copy`, SPAWNED_AT + 60_000],
      [`${gone}-x`, SPAWNED_AT - 500]
    ]
    for (const [name, at] of folders) {
      await mkdir(join(root, name))
      await utimes(join(root, name), at / 1000, at / 1000)
    }
    // A launch never waits for the sweep, only for its own chat's removals.
    await clearEarlierRunsOnce(root, 'new-chat', (path) => rm(path, { recursive: true }))
    await vi.waitFor(async () =>
      expect((await readdir(root)).sort()).toEqual([`${kept}-agent`, `${kept}-copy`, `${kept}-old`])
    )
    await rm(root, { recursive: true })
  })
})
