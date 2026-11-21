import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { uploadPeerMailFiles } from './peer-mail-files'

const SERVER = { environmentId: 'env-1', name: 'Studio', peerFingerprint: 'fp', pairingRevision: 3 }
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-mail-files-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it("uploads each file to the paired Orca's store for the item's chat and returns the stored paths", async () => {
  const shot = join(dir, 'after.png')
  writeFileSync(shot, Buffer.alloc(5))
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const callOrchestrationWorkerServer = vi.fn(
    async (_server: string, method: string, params: unknown) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every call here sends an object of params.
      calls.push({ method, params: params as Record<string, unknown> })
      switch (method) {
        case 'bots.items.owner.show':
          return { item: { chat: { id: 'chat-7' } }, events: [] }
        case 'agentSessionAttachment.uploadStart':
          return { uploadId: 'u1' }
        case 'agentSessionAttachment.uploadCommit':
          return { path: '/srv/orca/agent-session-attachments/u1/after.png' }
        default:
          return {}
      }
    }
  )

  await expect(
    uploadPeerMailFiles({ callOrchestrationWorkerServer }, SERVER, {
      to: 'bot:Pixel',
      item: '4',
      files: [shot]
    })
  ).resolves.toEqual(['/srv/orca/agent-session-attachments/u1/after.png'])
  expect(calls.map(({ method }) => method)).toEqual([
    'bots.items.owner.show',
    'agentSessionAttachment.uploadStart',
    'agentSessionAttachment.uploadAppend',
    'agentSessionAttachment.uploadCommit'
  ])
  expect(calls[1]?.params).toEqual({ sessionId: 'chat-7', name: 'after.png', byteLength: 5 })
})

it('sends nothing for a file it cannot read or without an item', async () => {
  const callOrchestrationWorkerServer = vi.fn()
  const runtime = { callOrchestrationWorkerServer }
  await expect(
    uploadPeerMailFiles(runtime, SERVER, {
      to: 'bot:Pixel',
      item: '4',
      files: [join(dir, 'gone.log')]
    })
  ).rejects.toThrow("gone.log can't be read. Nothing was sent.")
  await expect(
    uploadPeerMailFiles(runtime, SERVER, { to: 'bot:Pixel', files: [join(dir, 'gone.log')] })
  ).rejects.toThrow('--file goes with --to bot:<name> --item <n>')
  expect(callOrchestrationWorkerServer).not.toHaveBeenCalled()
})

it('refuses more than ten non-image files before uploading any', async () => {
  const callOrchestrationWorkerServer = vi.fn()
  const files = Array.from({ length: 11 }, (_, index) => join(dir, `log-${index}.txt`))
  await expect(
    uploadPeerMailFiles({ callOrchestrationWorkerServer }, SERVER, {
      to: 'bot:Pixel',
      item: '4',
      files
    })
  ).rejects.toThrow('A message takes up to 10 files besides images. Nothing was sent.')
  expect(callOrchestrationWorkerServer).not.toHaveBeenCalled()
})
