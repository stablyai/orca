import { describe, expect, it } from 'vitest'
import { BOT_SHARE_ERRORS } from '../../../shared/bots/bot-share-errors'
import { BotShareSkillReads, type BotShareSkillListing } from './bot-share-skill-reads'

const listing = (name: string): BotShareSkillListing => ({
  skills: [{ name, description: 'Steps', directory: `/skills/${name}`, homePath: null }],
  leftOut: []
})

/** A read that finishes when told to, and stops (rejecting) if aborted first, as a walk does. */
function walk() {
  let finish: (listing: BotShareSkillListing) => void = () => {}
  const stopped: AbortSignal[] = []
  const run = (signal: AbortSignal) =>
    new Promise<BotShareSkillListing>((resolve, reject) => {
      finish = resolve
      signal.addEventListener('abort', () => {
        stopped.push(signal)
        reject(signal.reason)
      })
    })
  return { run, stopped, finish: (value: BotShareSkillListing) => finish(value) }
}

// STA-16989: every pick walked every skill folder again; a replaced walk ran on.
describe('BotShareSkillReads', () => {
  it("stops a dialog's replaced read, which fails as prepare-again, and keeps the new one", async () => {
    const reads = new BotShareSkillReads()
    const opening = walk()
    const first = reads.read('dialog', 'sources', false, opening.run)
    // A pick while the dialog's first read runs waits for that read.
    const pick = reads.read('dialog', 'sources', true, async () => listing('unread'))

    const rebuilt = reads.read('dialog', 'sources', false, async () => listing('deploy'))

    await expect(first).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
    await expect(pick).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
    await expect(rebuilt).resolves.toEqual(listing('deploy'))
    expect(opening.stopped).toHaveLength(1)
    await expect(
      reads.read('dialog', 'sources', true, async () => listing('unread'))
    ).resolves.toEqual(listing('deploy'))
  })

  it("neither shares nor stops another dialog's read", async () => {
    const reads = new BotShareSkillReads()
    const before = walk()
    // One dialog reads; another opens after the bot's links changed.
    const first = reads.read('dialog-1', 'links-before', false, before.run)
    await expect(
      reads.read('dialog-2', 'links-after', false, async () => listing('far'))
    ).resolves.toEqual(listing('far'))

    before.finish(listing('triage'))
    await expect(first).resolves.toEqual(listing('triage'))
    await expect(
      reads.read('dialog-1', 'links-before', true, async () => listing('unread'))
    ).resolves.toEqual(listing('triage'))
  })

  it('gives a failed replacement its own error and reads again on the next pick', async () => {
    const reads = new BotShareSkillReads()
    const first = reads.read('dialog', 'sources', false, walk().run)
    const failed = reads.read('dialog', 'sources', false, () => Promise.reject(new Error('EACCES')))

    await expect(first).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
    await expect(failed).rejects.toThrow('EACCES')
    await expect(
      reads.read('dialog', 'sources', true, async () => listing('triage'))
    ).resolves.toEqual(listing('triage'))
  })

  it('keeps only the dialogs opened most recently', async () => {
    const reads = new BotShareSkillReads()
    for (let index = 1; index <= 9; index += 1) {
      await reads.read(`dialog-${index}`, 'sources', false, async () => listing(`opened-${index}`))
    }

    const reread = async () => listing('reread')
    await expect(reads.read('dialog-1', 'sources', true, reread)).resolves.toEqual(
      listing('reread')
    )
    await expect(reads.read('dialog-9', 'sources', true, reread)).resolves.toEqual(
      listing('opened-9')
    )
  })
})
