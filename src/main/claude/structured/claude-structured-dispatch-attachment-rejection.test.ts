import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'

describe('Claude structured dispatch attachment rejections', () => {
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
