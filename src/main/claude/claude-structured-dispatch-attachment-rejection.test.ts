// What a person reads when Orca refuses a message's attachments before sending it.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'

describe('Claude structured dispatch attachment rejections', () => {
  it('rejects more than twenty URL images before sending', async () => {
    const session = sessionFor()
    const body = userMessage(
      Array.from({ length: 21 }, (_, index) => ({
        type: 'image-ref' as const,
        url: `https://example.test/${index}.png`
      }))
    )

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
    ).resolves.toEqual({
      state: 'rejected',
      reason: 'Claude accepts at most 20 images in one message, so this message was not sent.',
      rejection: { kind: 'attachmentInvalid' }
    })
    expect(session.connection.send).not.toHaveBeenCalled()
  })

  it('rejects local images whose aggregate size exceeds twenty MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-images-'))
    try {
      const paths = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const path = join(directory, `${index}.png`)
          await writeFile(path, Buffer.alloc(5 * 1024 * 1024))
          return path
        })
      )
      const session = sessionFor()
      const body = userMessage(paths.map((path) => ({ type: 'image-ref' as const, path })))

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
      ).resolves.toEqual({
        state: 'rejected',
        reason:
          'The images on this message add up to more than 20 MB, so the message was not sent.',
        rejection: { kind: 'attachmentInvalid' }
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a local image by actual bytes read beyond the per-image cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'oversized.png')
      await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1))
      const session = sessionFor()
      const body = userMessage([{ type: 'image-ref', path }])

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
      ).resolves.toEqual({
        state: 'rejected',
        reason:
          'An image on this message is empty or larger than 5 MB, so the message was not sent.',
        rejection: { kind: 'attachmentInvalid' }
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('names an unsupported image type in words a person can act on', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'picture.bmp')
      await writeFile(path, Buffer.alloc(64))
      const session = sessionFor()

      await expect(
        dispatchClaudeTurn(session, {
          clientMessageId: 'client-1',
          body: userMessage([{ type: 'image-ref', path }])
        })
      ).resolves.toEqual({
        state: 'rejected',
        reason:
          'Claude accepts only PNG, JPEG, GIF, and WebP images, so this message was not sent.',
        rejection: { kind: 'attachmentInvalid' }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an attachment it cannot read with the generic sentence and no path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = sessionFor()
    const path = join(tmpdir(), 'orca-claude-image-missing', 'gone.png')

    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'image-ref', path }])
      })
    ).resolves.toEqual({
      state: 'rejected',
      reason: "An attachment on this message couldn't be read, so the message was not sent.",
      rejection: { kind: 'attachmentUnreadable' }
    })
    expect(session.connection.send).not.toHaveBeenCalled()
    // The row drops the error, so the log is the only place left to find why.
    expect(warn).toHaveBeenCalledWith(
      '[claude-dispatch] attachment could not be read:',
      expect.objectContaining({ code: 'ENOENT' })
    )
    warn.mockRestore()
  })
})
