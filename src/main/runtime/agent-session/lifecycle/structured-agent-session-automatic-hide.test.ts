import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { retireCapturedStructuredSessionSurface } from './structured-agent-session-close'

/** A host whose one chat has tab `t1` until a hide commits; `check` runs where the store write would. */
function hidingHost() {
  let tabId: string | null = 't1'
  const writes: unknown[] = []
  const host = {
    getSessionTabId: () => tabId,
    setSessionTabVisibility: vi.fn(
      async (_id: string, _visible: boolean, _tab: unknown, options: { check?: () => void }) => {
        options.check?.()
        writes.push(options)
        tabId = null
      }
    ),
    notifySessionTabHidden: vi.fn(),
    deps: { logger: { warn: vi.fn() } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hide reads only the members above.
  return { host: host as unknown as StructuredAgentSessionHost, fake: host, writes }
}

describe("retireCapturedStructuredSessionSurface, Orca's own hide", () => {
  it('commits in the background, keeping recovery, when admission passes inside the write', async () => {
    const { host, fake, writes } = hidingHost()
    const admit = vi.fn()
    const result = await retireCapturedStructuredSessionSurface(
      host,
      's1',
      { tableId: 't1' },
      undefined,
      true,
      { admit }
    )
    expect(result).toEqual({ committed: true })
    expect(admit).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([expect.objectContaining({ background: true, keepRecovery: true })])
    expect(fake.notifySessionTabHidden).toHaveBeenCalledWith('s1')
  })

  it('commits nothing and retires nothing when admission refuses inside the write', async () => {
    const { host, fake, writes } = hidingHost()
    const result = await retireCapturedStructuredSessionSurface(
      host,
      's1',
      { tableId: 't1' },
      undefined,
      true,
      {
        admit: () => {
          throw new Error('busy now')
        }
      }
    )
    expect(result).toEqual({ committed: false })
    expect(writes).toEqual([])
    expect(fake.notifySessionTabHidden).not.toHaveBeenCalled()
    expect(fake.deps.logger.warn).not.toHaveBeenCalled()
  })
})
