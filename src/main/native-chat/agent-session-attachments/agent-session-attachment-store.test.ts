import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
const fault = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return {
    ...fs,
    readdir: (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === fault.path) {
        throw Object.assign(new Error('listing failed'), { code: 'EIO' })
      }
      return fs.readdir(...args)
    }
  }
})
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'
import { AgentSessionAttachmentStore } from './agent-session-attachment-store'

const roots: string[] = []
afterEach(async () => {
  fault.path = ''
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the image already in a folder when a later write of the same bytes fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-attachment-store-'))
  roots.push(root)
  const store = new AgentSessionAttachmentStore(root, { hasSession: () => true })
  const bytes = Buffer.from('same image bytes')
  const kept = store.storeContent(bytes, '.png')
  await store.whenWritten(kept)
  const uploadDir = dirname(kept)
  // The same bytes the same day reuse the folder; this write cannot create its part file, and the
  // folder can't be listed while it cleans up.
  await mkdir(join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE))
  fault.path = uploadDir
  const failed = store.storeContent(bytes, '.jpg')
  await store.whenWritten(failed)
  expect(await readFile(kept, 'utf8')).toBe('same image bytes')
})
