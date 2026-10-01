import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'
import { verifyUnstoppedPtys } from './unstopped-pty-verification'

function providerAnswering(verdicts: Record<string, boolean | null>): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: verification reads only confirmPtyStopped and listProcesses.
  return {
    confirmPtyStopped: vi.fn(async (id: string) => verdicts[id] ?? null),
    listProcesses: vi.fn(async () => {
      throw new Error('a previous version did not answer')
    })
  } as unknown as IPtyProvider
}

describe('verifyUnstoppedPtys with a provider that confirms stops per owner', () => {
  it('reads exited from each owner without the merged list another version fails', async () => {
    const provider = providerAnswering({ 'wt@@a': true, 'wt@@b': true })

    await expect(verifyUnstoppedPtys(['wt@@a', 'wt@@b'], provider, 1_000)).resolves.toEqual({
      status: 'exited'
    })
    expect(provider.listProcesses).not.toHaveBeenCalled()
  })

  it('names only the sessions their owner still holds', async () => {
    const provider = providerAnswering({ 'wt@@a': true, 'wt@@b': false })

    await expect(verifyUnstoppedPtys(['wt@@a', 'wt@@b'], provider, 1_000)).resolves.toEqual({
      status: 'live',
      ptyIds: ['wt@@b']
    })
  })

  it('keeps a session whose owner did not answer unverifiable, never exited', async () => {
    const provider = providerAnswering({ 'wt@@a': true, 'wt@@frozen': null })

    await expect(
      verifyUnstoppedPtys(['wt@@a', 'wt@@frozen'], provider, 1_000)
    ).resolves.toMatchObject({ status: 'unverifiable' })
  })

  it('reads an id the listing tied to a silent version as unverifiable without asking its owner', async () => {
    const provider = providerAnswering({ 'wt@@a': true, 'wt@@silent': true })

    await expect(
      verifyUnstoppedPtys(['wt@@a', 'wt@@silent'], provider, 1_000, new Set(['wt@@silent']))
    ).resolves.toMatchObject({ status: 'unverifiable' })
    expect(provider.confirmPtyStopped).toHaveBeenCalledTimes(1)
    expect(provider.confirmPtyStopped).not.toHaveBeenCalledWith('wt@@silent', expect.anything())
  })
})
