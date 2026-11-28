import { describe, expect, it } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { peerMailStoredNothing, withUnattachedUploads } from './peer-mail-unattached'

const server = { name: 'devB' }

describe('files a failed send left on the server', () => {
  it('tells a refusal that stored nothing from an answer that never came back', () => {
    const refusal = (code: string, data?: unknown) => new OrchestrationError(code, 'No.', data)
    expect(peerMailStoredNothing(refusal('invalid_argument'))).toBe(true)
    expect(peerMailStoredNothing(refusal('bot_paused', { effectsApplied: false }))).toBe(true)
    expect(peerMailStoredNothing(refusal('bot_paused', { effectsApplied: true }))).toBe(false)
    expect(peerMailStoredNothing(refusal('runtime_timeout'))).toBe(false)
    expect(peerMailStoredNothing(refusal('invalid_runtime_response'))).toBe(false)
    expect(peerMailStoredNothing(new Error('socket closed'))).toBe(false)
  })

  it('leaves an error alone when no file reached the server', () => {
    const error = new OrchestrationError('invalid_argument', 'No. Nothing was sent.')
    expect(withUnattachedUploads(error, server, { copied: 0 })).toBe(error)
  })

  it('says files a chat still holds stay with that chat', () => {
    const error = new OrchestrationError(
      'peer_mail_files_kept',
      'Docs is paused. Nothing was sent.',
      { cause: 'bot_paused', effectsApplied: false, filesKept: true }
    )
    expect(withUnattachedUploads(error, server, { copied: 2 })).toMatchObject({
      code: 'peer_mail_not_sent',
      message:
        "Docs is paused. The message wasn't sent. 2 files already copied to devB for it are still held there by a chat; Orca on devB removes them with that chat.",
      data: { cause: 'bot_paused', effectsApplied: true, unattachedUploads: 2, filesKept: true }
    })
  })

  it('names a plain error and drops the server’s own not-sent sentence', () => {
    expect(withUnattachedUploads(new Error('socket closed'), server, { copied: 1 })).toMatchObject({
      code: 'peer_mail_not_sent',
      message:
        "socket closed. The message wasn't sent. A file already copied to devB for it is attached to nothing there; Orca on devB clears unused uploads later."
    })
    expect(
      withUnattachedUploads(
        new OrchestrationError('session_closed', 'That chat closed. No message was sent.'),
        server,
        { copied: 1 }
      )
    ).toMatchObject({
      message: expect.stringMatching(/^That chat closed\. The message wasn't sent\./)
    })
  })
})
