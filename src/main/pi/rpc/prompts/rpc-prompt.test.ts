import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { preparePiRpcPrompt } from './rpc-prompt'

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function pngOfSize(bytes: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-pi-prompt-'))
  directories.push(directory)
  const path = join(directory, `${bytes}.png`)
  await writeFile(path, PNG_SIGNATURE)
  await truncate(path, bytes)
  return path
}

function message(paths: string[]): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'look' },
      ...paths.map((path) => ({ type: 'image-ref' as const, path }))
    ]
  }
}

describe('preparePiRpcPrompt', () => {
  it('sends a 6 MiB PNG for a Pi that shrinks images', async () => {
    const path = await pngOfSize(6 * 1024 * 1024)

    const prompt = await preparePiRpcPrompt(message([path]), true)

    expect(prompt.images).toHaveLength(1)
    expect(prompt.images[0]?.mimeType).toBe('image/png')
    expect(prompt.images[0]?.data).toHaveLength(8 * 1024 * 1024)
    expect(prompt.images[0]?.data.startsWith('iVBORw0KGgo')).toBe(true)
  })

  it('reports an image total over 64 MiB as too large a total, not as history', async () => {
    const path = await pngOfSize(22 * 1024 * 1024)

    await expect(preparePiRpcPrompt(message([path, path, path]), true)).rejects.toMatchObject({
      failure: {
        kind: 'attachmentInvalid',
        attachment: { reason: 'totalTooLarge', limit: 64 * 1024 * 1024 }
      }
    })
  })

  it("refuses an image over Anthropic's base64 limit for a Pi that sends it unshrunk", async () => {
    const path = await pngOfSize(4 * 1024 * 1024)

    await expect(preparePiRpcPrompt(message([path]), false)).rejects.toMatchObject({
      failure: {
        kind: 'attachmentInvalid',
        attachment: { reason: 'tooLarge', limit: 3_932_160 }
      }
    })
  })
})
