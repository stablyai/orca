import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fitAgentMessageImages } from './agent-image-fit-client'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const worker = vi.hoisted(() => ({
  dispatch: vi.fn(async (build: (id: number) => unknown) => {
    build(1)
    return { id: 1, ok: true, path: '/fitted.png' }
  })
}))
vi.mock('../../worker-threads/worker-thread-request-queue', () => ({
  WorkerThreadRequestQueue: class {
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
    expect(
      first.blocks.every((block) => block.type === 'image-ref' && block.path === '/fitted.png')
    ).toBe(true)
    expect(fresh).toEqual(first)
    expect(worker.dispatch).toHaveBeenCalledTimes(1)
  }
)
