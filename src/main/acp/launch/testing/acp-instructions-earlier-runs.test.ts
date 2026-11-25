import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { nativeChatScratchFolderName } from '../../../native-chat/conversation-files/native-chat-scratch-folder'

const SPAWNED_AT = 1_800_000_000_000
vi.mock('../../../provider-relay/app-provider-relays', () => ({
  listProviderRelaysAtLaunch: async () => {}
}))
vi.mock('../../../provider-relay/provider-relay-launch-inventory', () => ({
  keptProviderRelaysComplete: () => true,
  providerRelayChatsKeptThisRun: () => new Map([['kept-chat', SPAWNED_AT]])
}))

const { clearEarlierRunsOnce } = await import('../acp-instructions-earlier-runs')

describe('clearing earlier runs’ instruction folders', () => {
  it("keeps the kept agent's own launch folder, even beside a newer copy's, and drops the rest", async () => {
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
    await clearEarlierRunsOnce(root, 'new-chat', (path) => rm(path, { recursive: true }))
    expect((await readdir(root)).sort()).toEqual([`${kept}-agent`, `${kept}-copy`])
    await rm(root, { recursive: true })
  })
})
