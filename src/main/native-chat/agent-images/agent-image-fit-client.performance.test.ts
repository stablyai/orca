import type * as FileSystem from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentImageFitError,
  fitAgentImagePath,
  fitAgentMessageImages
} from './agent-image-fit-client'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const intake = vi.hoisted(() => ({ checked: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const info = await actual.stat(...args)
      intake.checked++
      return info
    }
  }
})

const publication = vi.hoisted(() => ({ hold: Promise.resolve() }))
vi.mock('./agent-image-publication', () => ({
  publishAgentImage: async (result: { path: string }) => {
    await publication.hold
    return result.path
  }
}))

const worker = vi.hoisted(() => ({
  dispatch: vi.fn(async (build: (id: number) => unknown) => {
    build(1)
    return { id: 1, ok: true, path: '/fitted.png' }
  })
}))
vi.mock('../../../shared/file-content/node-bounded-file-reader', () => ({
  readNodeFileWithinLimit: async () => {
    throw new Error('EACCES')
  }
}))
vi.mock('../../worker-threads/worker-thread-request-queue', () => ({
  WorkerThreadRequestQueue: class {
    async retired() {}
    dispatch = worker.dispatch
  }
}))
vi.mock('../../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/temp' })
}))
vi.mock('../paste-files/native-chat-paste-files', () => ({
  nativeChatPasteFolder: () => '/pastes',
  isInsideNativeChatPasteFolder: () => false
}))
vi.mock('../agent-session-attachments/agent-session-attachment-store-registry', () => ({
  getAgentSessionAttachmentStore: () => null
}))
const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  intake.checked = 0
  publication.hold = Promise.resolve()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([2, 20])(
  'prepares an unchanged source once across %i references and fresh admission',
  async (count) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-image-fit-client-'))
    roots.push(root)
    const source = join(root, 'shot.png')
    await writeFile(source, Buffer.alloc(6 * 1024 * 1024))
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: Array.from({ length: count }, () => ({ type: 'image-ref', path: source }))
    }
    const fitted = new Map<string, string>()
    const first = await fitAgentMessageImages(body, undefined, fitted)
    const fresh = await fitAgentMessageImages(body, undefined, fitted)
    expect(first.blocks.filter((block) => block.type === 'image-ref')).toHaveLength(count)
    expect(
      first.blocks
        .filter((block) => block.type === 'image-ref')
        .every((block) => block.path === '/fitted.png')
    ).toBe(true)
    expect(fresh).toEqual(first)
    expect(
      first.blocks.some(
        (block) =>
          block.type === 'text' && block.text.includes(source) && block.text.includes('/fitted.png')
      )
    ).toBe(true)
    expect(body.blocks.every((block) => block.type === 'image-ref' && block.path === source)).toBe(
      true
    )
    expect(worker.dispatch).toHaveBeenCalledTimes(1)
  }
)

it('keeps a header read failure provably before provider delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-image-fit-client-'))
  roots.push(root)
  const source = join(root, 'small.png')
  await writeFile(source, 'small')
  await expect(fitAgentImagePath(source)).rejects.toBeInstanceOf(AgentImageFitError)
})

it.each([10, 100])(
  'keeps decoded results bounded while publication stalls under %i sends',
  async (count) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-image-admission-'))
    roots.push(root)
    const source = join(root, 'shot.png')
    await writeFile(source, Buffer.alloc(6 * 1024 * 1024))
    let resume: () => void = () => {}
    publication.hold = new Promise<void>((resolve) => {
      resume = resolve
    })
    const first = fitAgentImagePath(source)
    await vi.waitFor(() => expect(worker.dispatch).toHaveBeenCalledTimes(1))
    const results = Array.from({ length: count }, () =>
      fitAgentImagePath(source).then(
        () => 'sent',
        () => 'refused'
      )
    )
    try {
      await vi.waitFor(() => expect(intake.checked).toBe(count + 1))
      expect(worker.dispatch).toHaveBeenCalledTimes(1)
    } finally {
      resume()
    }
    await expect(first).resolves.toBe('/fitted.png')
    await Promise.all(results)
    await expect(fitAgentImagePath(source)).resolves.toBe('/fitted.png')
  }
)

it.each(['claude', 'pi'])(
  'leaves known image-count refusals to %s before preparing copies',
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-image-count-'))
    roots.push(root)
    const source = join(root, 'shot.png')
    await writeFile(source, Buffer.alloc(6 * 1024 * 1024))
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: Array.from({ length: 21 }, () => ({ type: 'image-ref', path: source }))
    }
    expect(await fitAgentMessageImages(body, undefined, undefined, provider)).toBe(body)
    expect(worker.dispatch).not.toHaveBeenCalled()
    await fitAgentMessageImages(
      { ...body, blocks: body.blocks.slice(0, 20) },
      undefined,
      undefined,
      provider
    )
    expect(worker.dispatch).toHaveBeenCalledTimes(1)
  }
)
