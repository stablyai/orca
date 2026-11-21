import { describe, expect, it } from 'vitest'
import { BotShareSkillReads, type BotShareSkillListing } from './bot-share-skill-reads'

const listing = (name: string): BotShareSkillListing => ({
  skills: [{ name, description: 'Steps', directory: `/skills/${name}`, homePath: null }],
  leftOut: []
})

/** A read that finishes only when stopped, as a long walk would. */
const untilStopped = (stopped: AbortSignal[]) => (signal: AbortSignal) =>
  new Promise<BotShareSkillListing>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      stopped.push(signal)
      reject(signal.reason)
    })
  })

// STA-16989: a pick's scan ran on after a newer one replaced it.
describe('BotShareSkillReads', () => {
  it('stops a read a rebuild replaces and gives its waiters the new listing', async () => {
    const reads = new BotShareSkillReads()
    const stopped: AbortSignal[] = []
    const opening = reads.read('bot', 'sources', false, untilStopped(stopped))
    // A pick while the dialog's first read runs waits for that read.
    const pick = reads.read('bot', 'sources', true, () => Promise.resolve(listing('unread')))

    const rebuilt = reads.read('bot', 'sources', false, async () => listing('deploy'))

    await expect(opening).resolves.toEqual(listing('deploy'))
    await expect(pick).resolves.toEqual(listing('deploy'))
    await expect(rebuilt).resolves.toEqual(listing('deploy'))
    expect(stopped).toHaveLength(1)
  })

  it('reads again on the next pick after a read failed', async () => {
    const reads = new BotShareSkillReads()
    await expect(
      reads.read('bot', 'sources', false, () => Promise.reject(new Error('EACCES')))
    ).rejects.toThrow('EACCES')

    await expect(
      reads.read('bot', 'sources', true, async () => listing('triage'))
    ).resolves.toEqual(listing('triage'))
  })
})
