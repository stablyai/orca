import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { fitAgentImagePath } from './agent-image-fit-client'
import { prepareAgentImageFile } from './agent-image-fit'
import { nativeChatPasteFolder } from '../paste-files/native-chat-paste-files'
import type { AgentImageFitRequest } from './agent-image-fit-protocol'

const storage = vi.hoisted(() => ({ root: '' }))
vi.mock('../../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => storage.root })
}))
vi.mock('../agent-session-attachments/agent-session-attachment-store-registry', () => ({
  getAgentSessionAttachmentStore: () => null
}))
vi.mock('../../worker-threads/worker-thread-request-queue', () => ({
  WorkerThreadRequestQueue: class {
    async retired() {}
    async dispatch(build: (id: number) => AgentImageFitRequest) {
      const request = build(1)
      return {
        id: request.id,
        ok: true,
        ...(await prepareAgentImageFile(request.path, request.outputDirectory))
      }
    }
  }
}))

afterEach(async () => {
  await rm(storage.root, { recursive: true, force: true })
})

it.each([10, 100])(
  'retains one viewing copy across two intake routes for %i images',
  async (count) => {
    storage.root = await mkdtemp(join(tmpdir(), 'orca-image-retention-'))
    const pastes = nativeChatPasteFolder()
    const external = join(storage.root, 'external')
    await mkdir(pastes, { recursive: true })
    await mkdir(external)
    for (let index = 0; index < count; index++) {
      const image = new PNG({ width: 8001, height: 1 })
      image.data.fill(index + 1)
      const bytes = PNG.sync.write(image)
      const paste = join(pastes, `source-${index}.png`)
      const file = join(external, `source-${index}.png`)
      await writeFile(paste, bytes)
      await writeFile(file, bytes)
      const first = await fitAgentImagePath(paste)
      expect(first).not.toBe(paste)
      expect(await fitAgentImagePath(file)).toBe(first)
    }
    const retained = (await readdir(pastes, { recursive: true })).filter((path) =>
      path.split(/[\\/]/).at(-1)?.startsWith('v2-')
    )
    expect(retained).toHaveLength(count)
  },
  30_000
)
