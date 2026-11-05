import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { resolvePairedCallerHostId } from './paired-caller-host-id'

function repos(...hostIds: (string | undefined)[]): Repo[] {
  return hostIds.map((executionHostId, index) => ({
    id: 'repo-1',
    path: `/repo-${index}`,
    executionHostId
  })) as unknown as Repo[]
}

const SELECTOR = 'id:repo-1::/repo/wt'

describe('resolvePairedCallerHostId', () => {
  it('passes through our own vocabulary and an absent qualifier', () => {
    expect(resolvePairedCallerHostId(() => repos('local'), SELECTOR, 'local')).toBe('local')
    expect(resolvePairedCallerHostId(() => repos('ssh:a'), SELECTOR, 'ssh:a')).toBe('ssh:a')
    expect(resolvePairedCallerHostId(() => repos('local'), SELECTOR, undefined)).toBeUndefined()
  })

  it('answers with `local` when nothing carries the client-minted stamp', () => {
    expect(resolvePairedCallerHostId(() => repos('local'), SELECTOR, 'runtime:env-1')).toBe('local')
    expect(resolvePairedCallerHostId(() => repos('ssh:a'), SELECTOR, 'runtime:env-1')).toBe('local')
    expect(resolvePairedCallerHostId(() => [], SELECTOR, 'runtime:env-1')).toBe('local')
  })

  it('keeps a stamp this store still uses for its own repo', () => {
    expect(resolvePairedCallerHostId(() => repos('runtime:env-1'), SELECTOR, 'runtime:env-1')).toBe(
      'runtime:env-1'
    )
  })

  it('ignores another repo id carrying the other spelling', () => {
    const otherRepo = { id: 'repo-2', path: '/other' } as unknown as Repo
    expect(
      resolvePairedCallerHostId(
        () => [...repos('runtime:env-1'), otherRepo],
        SELECTOR,
        'runtime:env-1'
      )
    ).toBe('runtime:env-1')
  })

  it('refuses to guess when one repo id carries both spellings', () => {
    expect(() =>
      resolvePairedCallerHostId(() => repos('local', 'runtime:env-1'), SELECTOR, 'runtime:env-1')
    ).toThrow('ambiguous across hosts')
  })

  it('falls back to every repo when the selector names no repo id', () => {
    expect(
      resolvePairedCallerHostId(() => repos('runtime:env-1'), 'feature/x', 'runtime:env-1')
    ).toBe('runtime:env-1')
    expect(resolvePairedCallerHostId(() => repos('local'), 'feature/x', 'runtime:env-1')).toBe(
      'local'
    )
  })
})
