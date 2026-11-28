import { describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { admitWithClaimedFiles, type ClaimedMailFiles } from './bot-mail-files-claim'

function claimed(released = true): ClaimedMailFiles & { release: ReturnType<typeof vi.fn> } {
  return { current: vi.fn(), release: vi.fn(async () => released) }
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
      admitWithClaimedFiles(files, (current) => {
        expect(current).toBe(files.current)
        throw refusal
      })
    ).rejects.toBe(refusal)
    expect(files.release).toHaveBeenCalledOnce()
  })

  it('says the files are kept when their claims could not be given back', async () => {
    const files = claimed(false)
    await expect(
      admitWithClaimedFiles(files, () => {
        throw new OrchestrationError('bot_paused', 'Docs is paused. Nothing was sent.', {
          effectsApplied: false
        })
      })
    ).rejects.toMatchObject({
      code: 'bot_paused',
      data: { effectsApplied: false, filesKept: true }
    })
  })
})
