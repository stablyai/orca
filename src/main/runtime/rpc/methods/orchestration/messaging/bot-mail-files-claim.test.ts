import { describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { admitWithClaimedFiles, type ClaimedMailFiles } from './bot-mail-files-claim'

function claimed(released = true): ClaimedMailFiles & { release: ReturnType<typeof vi.fn> } {
  return { current: vi.fn(), stored: vi.fn(), release: vi.fn(async () => released) }
}

describe('storing mail whose files were claimed', () => {
  it('keeps the claims of mail it stored', async () => {
    const files = claimed()
    await expect(admitWithClaimedFiles(files, () => ({ sent: true, receipt: 'ok' }))).resolves.toBe(
      'ok'
    )
    expect(files.release).not.toHaveBeenCalled()
  })

  it('gives them back for a duplicate the bot already has', async () => {
    const files = claimed()
    await expect(
      admitWithClaimedFiles(files, () => ({ sent: false, receipt: 'duplicate' }))
    ).resolves.toBe('duplicate')
    expect(files.release).toHaveBeenCalledOnce()
  })

  it('gives them back for a refusal, and passes its current-check to the store', async () => {
    const files = claimed()
    const refusal = new OrchestrationError('bot_paused', 'Docs is paused. Nothing was sent.', {
      effectsApplied: false
    })
    await expect(
      admitWithClaimedFiles(files, (passed) => {
        passed?.current()
        expect(files.current).toHaveBeenCalledOnce()
        throw refusal
      })
    ).rejects.toBe(refusal)
    expect(files.release).toHaveBeenCalledOnce()
  })

  it('says the files may be kept when their claims could not be shown given back', async () => {
    const files = claimed(false)
    await expect(
      admitWithClaimedFiles(files, () => {
        throw new OrchestrationError('bot_paused', 'Docs is paused. Nothing was sent.', {
          effectsApplied: false
        })
      })
    ).rejects.toMatchObject({
      code: 'peer_mail_files_may_be_kept',
      message: 'Docs is paused. Nothing was sent.',
      data: { cause: 'bot_paused', effectsApplied: false, filesMaybeKept: true }
    })
  })
  it('keeps the claims of mail already stored when a later step fails', async () => {
    const files = claimed()
    await expect(
      admitWithClaimedFiles(files, (passed) => {
        passed?.stored()
        throw new Error('wake failed')
      })
    ).rejects.toMatchObject({
      code: 'peer_mail_stored',
      message: 'The message was delivered with its files, then this failed: wake failed',
      data: { effectsApplied: true }
    })
    expect(files.release).not.toHaveBeenCalled()
  })

  it('says files may be kept for a plain error whose claims could not be given back', async () => {
    await expect(
      admitWithClaimedFiles(claimed(false), () => {
        throw new Error('database is locked')
      })
    ).rejects.toMatchObject({
      code: 'peer_mail_files_may_be_kept',
      message: 'database is locked',
      data: { effectsApplied: false, filesMaybeKept: true }
    })
  })
  it('says mail about an item was delivered when a step after storing it fails', async () => {
    await expect(
      admitWithClaimedFiles(
        undefined,
        (passed) => {
          passed?.stored()
          throw new Error('wake failed')
        },
        true
      )
    ).rejects.toMatchObject({ code: 'peer_mail_stored', data: { effectsApplied: true } })
  })
})
