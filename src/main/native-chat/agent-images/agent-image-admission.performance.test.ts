import { afterEach, expect, it, vi } from 'vitest'
import { fitAgentImagePath } from './agent-image-fit-client'

const reader = vi.hoisted(() => ({
  calls: 0,
  resume: () => {},
  hold: Promise.resolve()
}))
vi.mock('node:fs/promises', () => ({
  stat: async () => ({ isFile: () => true, size: 1024 })
}))
vi.mock('../../../shared/file-content/node-bounded-file-reader', () => ({
  readNodeFileWithinLimit: async () => {
    reader.calls++
    await reader.hold
    return { buffer: Buffer.alloc(24) }
  }
}))
vi.mock('../agent-session-attachments/agent-session-attachment-store-registry', () => ({
  getAgentSessionAttachmentStore: () => null
}))

afterEach(() => {
  reader.calls = 0
})

it.each([100, 1000])(
  'bounds preflight reads and releases cancelled work across %i callers',
  async (count) => {
    reader.hold = new Promise<void>((resolve) => {
      reader.resume = resolve
    })
    const controllers = Array.from({ length: count }, () => new AbortController())
    const results = controllers.map((controller) =>
      fitAgentImagePath('/shot.png', controller.signal).catch(() => 'refused')
    )
    try {
      await vi.waitFor(() => expect(reader.calls).toBe(1))
      controllers.forEach((controller) => controller.abort())
      expect(reader.calls).toBe(1)
    } finally {
      reader.resume()
    }
    await Promise.all(results)
    expect(reader.calls).toBe(1)
    await expect(fitAgentImagePath('/successor.png')).resolves.toBe('/successor.png')
    expect(reader.calls).toBe(2)
  }
)
