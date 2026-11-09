import type * as RuntimeClientModule from '../runtime-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
const call = vi.hoisted(() => vi.fn())
vi.mock('../runtime-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeClientModule>()),
  RuntimeClient: class {
    call = call
  }
}))
import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  call.mockReset()
})

describe('orca tab create --chromeless', () => {
  it('combines the flag with profiles and split placement', async () => {
    vi.stubEnv('ORCA_TAB_ID', 'terminal-1')
    queueFixtures(call, okFixture('created', { browserPageId: 'page-1' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'tab',
        'create',
        '--url',
        'https://example.com',
        '--chromeless',
        '--profile',
        'work',
        '--split',
        'right',
        '--worktree',
        'all',
        '--json'
      ],
      '/tmp'
    )
    expect(call).toHaveBeenCalledWith(
      'browser.tabCreate',
      {
        url: 'https://example.com',
        worktree: undefined,
        profileId: 'work',
        chromeless: true,
        split: 'right',
        splitFromTabId: 'terminal-1'
      },
      { timeoutMs: 60_000 }
    )
  })
})
