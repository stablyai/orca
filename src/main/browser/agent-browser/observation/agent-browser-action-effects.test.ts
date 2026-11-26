import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { runWithActionEffects, type ActionEffectsHost } from './agent-browser-action-effects'

function pageHost(): { host: ActionEffectsHost; log: string[] } {
  const log: string[] = []
  let baseline = false
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async () => true
  })
  const host: ActionEffectsHost = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the effects path reads only the members faked above.
    guest: () => guest as unknown as WebContents,
    tabUrls: () => new Map(),
    loadError: () => null,
    withholdsPageText: () => false,
    hasDeltaBaseline: () => baseline,
    forgetDeltaBaseline: () => {
      baseline = false
    },
    snapshotDelta: async () => {
      log.push('snapshot')
      baseline = true
      return { snapshot: { kind: 'unchanged' } }
    },
    observePageEvents: () => () => {},
    admit: () => {}
  }
  return { host, log }
}

describe('runWithActionEffects', () => {
  it('skips the settle and page read with skip, and returns no effects', async () => {
    const { host, log } = pageHost()
    const action = async (): Promise<{ clicked: string }> => {
      log.push('action')
      return { clicked: 'e3' }
    }

    const result = await runWithActionEffects(host, action, { skip: true })

    expect(result).toEqual({ clicked: 'e3' })
    expect(log).toEqual(['action'])
  })

  it('takes a fresh baseline for the next effects after a skipped action', async () => {
    const { host, log } = pageHost()
    const action = (name: string) => async (): Promise<{ clicked: string }> => {
      log.push(name)
      return { clicked: name }
    }

    await runWithActionEffects(host, action('first'))
    await runWithActionEffects(host, action('fast'), { skip: true })
    const result = await runWithActionEffects(host, action('last'))

    expect(log).toEqual([
      'snapshot',
      'first',
      'snapshot',
      'fast',
      // The baseline the agent never saw is gone, so this action reads the page before it acts.
      'snapshot',
      'last',
      'snapshot'
    ])
    expect(result).toMatchObject({ clicked: 'last', effects: { page: 'unchanged' } })
  })
})
