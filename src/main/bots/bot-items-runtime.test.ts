import { expect, it, vi } from 'vitest'
import type { BotItemsHostDeps } from './bot-items-runtime'
import { BotItemsHost } from './bot-items-runtime'

const state = vi.hoisted(() => ({ directory: '/profile' }))

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.directory
}))

function hostWithRetentionRead(read: ReturnType<typeof vi.fn>): BotItemsHost {
  const remote = { owedCommentAttachmentUploads: read }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test exercises only the attachment-retention path, whose dependencies are supplied below.
  const deps = {
    workRuntime: {},
    db: { items: vi.fn(() => remote), dispose: vi.fn() },
    bots: () => [],
    githubCache: () => ({ pr: {}, issue: {} }),
    automations: () => [],
    chatTitle: () => null,
    chatExists: () => true,
    chatRoot: (id: string) => id,
    threadChats: () => [],
    automationRunChats: () => [],
    notify: () => {},
    sendMail: async () => true
  } as unknown as BotItemsHostDeps
  return new BotItemsHost(deps)
}

it('keeps item-mail attachment retention unknown until its store can read again', async () => {
  const read = vi.fn<() => Promise<string[]>>()
  const host = hostWithRetentionRead(read)

  expect(await host.owedCommentAttachmentUploads(state.directory, '/attachments')).toBeNull()

  read.mockResolvedValueOnce([])
  host.store()
  expect(await host.owedCommentAttachmentUploads(state.directory, '/attachments')).toEqual(
    new Set()
  )

  read.mockRejectedValueOnce(new Error('items database is temporarily unavailable'))
  expect(await host.owedCommentAttachmentUploads(state.directory, '/attachments')).toBeNull()

  read.mockResolvedValueOnce(['recovered-upload'])
  expect(await host.owedCommentAttachmentUploads(state.directory, '/attachments')).toEqual(
    new Set(['recovered-upload'])
  )
})
