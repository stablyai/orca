import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { oncePerDistro } from './wsl-orcad-account-env-wiring'

describe('oncePerDistro', () => {
  it('tells the user about each distro once per run, whatever its casing', () => {
    const send = vi.fn()
    const notify = oncePerDistro(send)
    notify('Ubuntu')
    notify('ubuntu')
    notify('Debian')
    notify('Ubuntu')
    expect(send.mock.calls).toEqual([['Ubuntu'], ['Debian']])
  })
})
