import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { AgentSessionAttachmentExpiredError } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import {
  admitBotItemCommentAttachments,
  type BotItemCommentAttachmentDeps
} from './bot-item-comment-attachments'

const UPLOAD_A = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
const UPLOAD_B = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'

let dir: string
let store: AgentSessionAttachmentStore
let claims: { sessionId: string; body: AgentJournalMessageItem }[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-item-comment-'))
  store = new AgentSessionAttachmentStore(join(dir, 'agent-session-attachments'), {
    hasSession: () => true
  })
  claims = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function deps(over: Partial<BotItemCommentAttachmentDeps> = {}): BotItemCommentAttachmentDeps {
  return {
    store,
    local: false,
    claim: async (sessionId, body) => {
      claims.push({ sessionId, body })
    },
    chat: async () => ({ sessionId: 'live-session', title: 'Login fixes' }),
    ...over
  }
}

async function stored(uploadId: string, name: string, bytes = 3): Promise<string> {
  await mkdir(join(store.rootDir, uploadId), { recursive: true })
  const path = join(store.rootDir, uploadId, name)
  await writeFile(path, Buffer.alloc(bytes))
  return path
}

it("claims the comment's images and store files for the item's live chat, sized on the host", async () => {
  const shot = await stored(UPLOAD_A, 'shot.png', 7)
  const log = await stored(UPLOAD_B, 'build.log')
  const text = `See @"${log}"`

  const { images } = await admitBotItemCommentAttachments(deps(), text, [shot])

  expect(images).toEqual([{ path: shot, name: 'shot.png', bytes: 7 }])
  expect(claims).toEqual([
    {
      sessionId: 'live-session',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text },
          { type: 'image-ref', path: shot }
        ]
      }
    }
  ])
})

it('leaves the journal alone for text naming no upload', async () => {
  const claim = vi.fn()
  await expect(
    admitBotItemCommentAttachments(deps({ claim }), 'See @src/app.ts', [])
  ).resolves.toEqual({ text: 'See @src/app.ts', images: [] })
  expect(claim).not.toHaveBeenCalled()
})

it('refuses a paired client a path outside the store and a non-image', async () => {
  const outside = join(dir, 'secret.png')
  await writeFile(outside, 'x')
  const notImage = await stored(UPLOAD_A, 'notes.txt')

  for (const path of [outside, notImage]) {
    await expect(admitBotItemCommentAttachments(deps(), '', [path])).rejects.toThrow(
      'Only pasted or attached images can go on a comment.'
    )
  }
  expect(claims).toEqual([])
})

// Windows needs elevation to make a symlink.
it.skipIf(process.platform === 'win32')('refuses a symlink planted in the store', async () => {
  const outside = join(dir, 'secret.png')
  await writeFile(outside, 'x')
  await mkdir(join(store.rootDir, UPLOAD_B), { recursive: true })
  const link = join(store.rootDir, UPLOAD_B, 'link.png')
  await symlink(outside, link)

  await expect(admitBotItemCommentAttachments(deps(), '', [link])).rejects.toThrow(
    'link.png: this attachment expired. Attach it again.'
  )
  expect(claims).toEqual([])
})

it("copies this host's own dropped image into the store before claiming it", async () => {
  const dropped = join(dir, 'Screen Shot.png')
  await writeFile(dropped, Buffer.alloc(5))

  const {
    images: [image]
  } = await admitBotItemCommentAttachments(deps({ local: true }), '', [dropped])

  expect(image?.path.startsWith(store.rootDir)).toBe(true)
  expect(image?.name).toBe('Screen Shot.png')
  expect(image?.bytes).toBe(5)
  expect(claims[0]?.body.blocks[1]).toEqual({ type: 'image-ref', path: image?.path })
})

it("holds comments to chat's 20-image and 64 MB limits", async () => {
  const many = Array.from({ length: 21 }, (_, n) => join(store.rootDir, `${UPLOAD_A}`, `${n}.png`))
  await expect(admitBotItemCommentAttachments(deps(), '', many)).rejects.toThrow(
    'Comments take up to 20 images.'
  )
  const big = [await stored(UPLOAD_A, 'a.png', 33 * 1024 * 1024)]
  big.push(await stored(UPLOAD_B, 'b.png', 33 * 1024 * 1024))
  await expect(admitBotItemCommentAttachments(deps(), '', big)).rejects.toThrow(
    'These images add up to 66 MB. A comment takes up to 64 MB.'
  )
})

it('counts a stored image with an outside one before copying the outside one in', async () => {
  const inStore = await stored(UPLOAD_A, 'a.png', 40 * 1024 * 1024)
  const dropped = join(dir, 'drop.png')
  await writeFile(dropped, Buffer.alloc(30 * 1024 * 1024))

  await expect(
    admitBotItemCommentAttachments(deps({ local: true }), '', [inStore, inStore, dropped])
  ).rejects.toThrow('These images add up to 70 MB. A comment takes up to 64 MB.')
  expect(await readdir(store.rootDir)).toEqual([UPLOAD_A])
})

it("says which upload expired, and refuses attachments once the item's chat is gone", async () => {
  const shot = await stored(UPLOAD_A, 'shot.png')
  const expired = deps({
    claim: async () => {
      throw new AgentSessionAttachmentExpiredError([{ uploadId: UPLOAD_A, name: 'shot.png' }])
    }
  })
  await expect(admitBotItemCommentAttachments(expired, '', [shot])).rejects.toThrow(
    'shot.png: this attachment expired. Attach it again.'
  )
  await expect(
    admitBotItemCommentAttachments(deps({ chat: async () => null }), '', [shot])
  ).rejects.toThrow("This item's chat was deleted, so files can't be attached here.")
})

it("refuses a comment naming an upload while this host's store is unavailable, and lets plain text through", async () => {
  const chat = vi.fn(async () => ({ sessionId: 'live-session', title: null }))
  const down = deps({ store: null, claim: null, chat })
  const log = `@"/srv/orca/agent-session-attachments/${UPLOAD_B}/build.log"`

  await expect(admitBotItemCommentAttachments(down, `See ${log}`, [])).rejects.toThrow(
    "This computer can't take attachments right now. Comment again in a moment."
  )
  await expect(admitBotItemCommentAttachments(down, 'Ship it', [])).resolves.toEqual({
    text: 'Ship it',
    images: []
  })
  expect(chat).not.toHaveBeenCalled()
})

it('refuses more than 10 files besides images', async () => {
  const many = Array.from({ length: 11 }, (_, n) => join(dir, `${n}.log`))
  await expect(admitBotItemCommentAttachments(deps({ local: true }), '', [], many)).rejects.toThrow(
    'Comments take up to 10 files besides images.'
  )
  expect(claims).toEqual([])
})

it('refuses more than 20 local images before copying any into the store', async () => {
  const many: string[] = []
  for (let n = 0; n < 21; n++) {
    const path = join(dir, `${n}.png`)
    await writeFile(path, Buffer.alloc(3))
    many.push(path)
  }
  await expect(admitBotItemCommentAttachments(deps({ local: true }), '', [], many)).rejects.toThrow(
    'Comments take up to 20 images.'
  )
  expect(await readdir(store.rootDir).catch(() => [])).toEqual([])
})
