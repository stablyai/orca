import { describe, expect, it } from 'vitest'
import type { DaemonSessionInfo } from '../daemon/types'
import { collectOrcadTerminalCensus } from './orcad-terminal-census'

function session(createdAt: number, protocolVersion = 7): DaemonSessionInfo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only createdAt and protocolVersion.
  return { sessionId: `s-${createdAt}`, createdAt, protocolVersion } as DaemonSessionInfo
}

describe('orcad terminal census', () => {
  it('counts live sessions, those since activation, and their single owning protocol', async () => {
    await expect(
      collectOrcadTerminalCensus(100, async () => [session(50), session(100), session(150)])
    ).resolves.toEqual({ liveSessions: 3, startedSinceActivation: 2, daemonProtocolVersion: 7 })
  })

  it('reports zero, not unknown, for an answered empty daemon', async () => {
    await expect(collectOrcadTerminalCensus(100, async () => [])).resolves.toEqual({
      liveSessions: 0,
      startedSinceActivation: 0,
      daemonProtocolVersion: null
    })
  })

  it('leaves the protocol unknown when sessions span daemon generations', async () => {
    const census = await collectOrcadTerminalCensus(0, async () => [session(1, 7), session(2, 6)])
    expect(census.daemonProtocolVersion).toBeNull()
    expect(census.liveSessions).toBe(2)
  })

  it('leaves the since-activation count unknown when a session has no creation time', async () => {
    const census = await collectOrcadTerminalCensus(0, async () => [session(0)])
    expect(census).toMatchObject({ liveSessions: 1, startedSinceActivation: null })
  })

  it.each([
    ['no inventory', async () => null],
    [
      'a failed inventory',
      async () => {
        throw new Error('daemon unreachable')
      }
    ]
  ])('reads %s as unverifiable, never as zero', async (_label, list) => {
    await expect(collectOrcadTerminalCensus(0, list)).resolves.toEqual({
      liveSessions: null,
      startedSinceActivation: null,
      daemonProtocolVersion: null
    })
  })
})
