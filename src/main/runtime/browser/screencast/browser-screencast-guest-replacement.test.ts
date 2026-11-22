import { describe, expect, it } from 'vitest'
import { BrowserScreencastGuestReplacements } from './browser-screencast-guest-replacement'

type Stream = {
  stopping: boolean
  session: { done: Promise<void> } | null
  started: Promise<{ done: Promise<void>; stop: () => void }>
}

function streamRecord(): { record: Stream; stopped: () => boolean } {
  let stopped = false
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const session = {
    done,
    stop: () => {
      stopped = true
      resolveDone()
    }
  }
  const record: Stream = { session, started: Promise.resolve(session), stopping: false }
  return { record, stopped: () => stopped }
}

describe('BrowserScreencastGuestReplacements', () => {
  it('stops the old stream before the swap and holds new viewers until the swap is done', async () => {
    const active = new Map<string, Stream>()
    const old = streamRecord()
    active.set('page', old.record)
    const replacements = new BrowserScreencastGuestReplacements(active)
    const events: string[] = []
    let finishSwap!: () => void
    const replaced = replacements.replace('page', async () => {
      events.push(old.stopped() ? 'swap after stop' : 'swap before stop')
      // The old stream's record leaves the map once its session is done, as browserScreencast does.
      active.delete('page')
      await new Promise<void>((resolve) => {
        finishSwap = resolve
      })
      events.push('swapped')
    })
    const joined = replacements.settledStream('page').then((stream) => {
      events.push(`viewer joined ${stream === undefined ? 'fresh' : 'old'}`)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['swap after stop'])
    finishSwap()
    await Promise.all([replaced, joined])
    expect(events).toEqual(['swap after stop', 'swapped', 'viewer joined fresh'])
  })
})
