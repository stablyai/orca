import { describe, expect, it, vi } from 'vitest'

import { ensureWslHookRelayForReattach } from './wsl-hook-relay-reattach'

describe('ensureWslHookRelayForReattach', () => {
  it('refreshes exact surviving distros across local reattachments', () => {
    const ensure = vi.fn()

    for (const wslDistro of ['Ubuntu-24.04', 'Ubuntu', 'Debian']) {
      ensureWslHookRelayForReattach({ isReattach: true, wslDistro }, null, ensure)
    }

    expect(ensure.mock.calls).toEqual([['Ubuntu-24.04'], ['Ubuntu'], ['Debian']])
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
})
