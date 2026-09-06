import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { acpPromptBlocks } from './acp-session-events'
import { MAX_CHAT_IMAGE_BYTES } from '../native-chat/chat-image-attachment'

describe('acpPromptBlocks', () => {
  it('rejects an image past the attachment ceiling instead of buffering it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-acp-image-limit-'))
    const path = join(dir, 'huge.png')
    await writeFile(path, Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1))
    const result = await acpPromptBlocks({ blocks: [{ type: 'image-ref', path }] }, true)
    expect(result).toEqual({
      ok: false,
      reason: `ACP image must be a non-empty file no larger than ${MAX_CHAT_IMAGE_BYTES} bytes`
    })
  })

  it('rejects an unreadable image without claiming an empty prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-acp-missing-'))
    const result = await acpPromptBlocks(
      { blocks: [{ type: 'image-ref', path: join(dir, 'missing.png') }] },
      true
    )
    expect(result.ok).toBe(false)
  })
})
