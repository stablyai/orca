import { describe, expect, it, vi } from 'vitest'

import { ensureWslHookRelayForReattach } from './wsl-hook-relay-reattach'

describe('ensureWslHookRelayForReattach', () => {
  it('refreshes the surviving session distro after a local reattach', () => {
    const ensure = vi.fn()

    ensureWslHookRelayForReattach({ isReattach: true, wslDistro: 'Ubuntu-24.04' }, null, ensure)

    expect(ensure).toHaveBeenCalledOnce()
    expect(ensure).toHaveBeenCalledWith('Ubuntu-24.04')
  })

  it.each([
    ['fresh WSL spawn', { wslDistro: 'Ubuntu' }, null],
    ['native reattach', { isReattach: true, wslDistro: null }, null],
    ['legacy reattach without ownership context', { isReattach: true }, null],
    ['blank distro', { isReattach: true, wslDistro: '  ' }, null],
    ['SSH reattach', { isReattach: true, wslDistro: 'Ubuntu' }, 'ssh-1']
  ])('does not refresh a %s', (_label, result, connectionId) => {
    const ensure = vi.fn()

    ensureWslHookRelayForReattach(result, connectionId, ensure)

    expect(ensure).not.toHaveBeenCalled()
  })

  it('preserves exact distro ownership across multiple local reattachments', () => {
    const ensure = vi.fn()

    ensureWslHookRelayForReattach({ isReattach: true, wslDistro: 'Ubuntu' }, null, ensure)
    ensureWslHookRelayForReattach({ isReattach: true, wslDistro: 'Debian' }, null, ensure)

    expect(ensure.mock.calls).toEqual([['Ubuntu'], ['Debian']])
  })
})
