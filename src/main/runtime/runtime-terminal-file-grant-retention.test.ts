import { describe, expect, it, vi } from 'vitest'
import { retainRuntimeTerminalFileGrant } from './runtime-terminal-file-grant-retention'

describe('retainRuntimeTerminalFileGrant', () => {
  it('preserves grants below the cap and evicts the oldest at admission', () => {
    const grants = new Map<string, { id: string }>()
    const release = vi.fn((id: string) => grants.delete(id))

    retainRuntimeTerminalFileGrant(grants, { id: 'a' }, release, 2)
    retainRuntimeTerminalFileGrant(grants, { id: 'b' }, release, 2)
    expect([...grants.keys()]).toEqual(['a', 'b'])
    expect(release).not.toHaveBeenCalled()

    retainRuntimeTerminalFileGrant(grants, { id: 'c' }, release, 2)
    expect([...grants.keys()]).toEqual(['b', 'c'])
    expect(release).toHaveBeenCalledWith('a', { id: 'a' })
  })
})
