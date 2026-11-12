import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
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
      rejection: { kind: 'attachmentInvalid', attachment: { reason: 'tooMany', limit: 20 } }
    })
    expect(session.connection.send).not.toHaveBeenCalled()
  })

  it('rejects local images whose aggregate size exceeds sixty-four MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-images-'))
    try {
      const paths = await Promise.all(
        Array.from({ length: 2 }, async (_, index) => {
          const path = join(directory, `${index}.png`)
          await writeFile(path, '')
          await truncate(path, 32 * 1024 * 1024 + 1)
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
          'The images on this message add up to more than 64 MB, so the message was not sent.',
        rejection: {
          kind: 'attachmentInvalid',
          attachment: { reason: 'totalTooLarge', limit: 64 * 1024 * 1024 }
        }
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
      await writeFile(path, '')
      await truncate(path, 50 * 1024 * 1024 + 1)
      const session = sessionFor()
      const body = userMessage([{ type: 'image-ref', path }])

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
      ).resolves.toEqual({
        state: 'rejected',
        reason: 'An image on this message is larger than 50 MB, so the message was not sent.',
        rejection: {
          kind: 'attachmentInvalid',
          attachment: { reason: 'tooLarge', limit: 50 * 1024 * 1024 }
        }
      })
      expect(session.connection.send).not.toHaveBeenCalled()
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
    expect(warn).toHaveBeenCalledWith(
      '[claude-dispatch] attachment could not be read:',
      expect.objectContaining({ code: 'ENOENT' })
    )
    warn.mockRestore()
  })
})
