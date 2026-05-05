/* eslint-disable max-lines -- Why: this file groups every CLI browser-command test (page targeting, profiles, waits, viewport) so test-fixture imports and the runtime-client mock stay shared in one place. */
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from './index'
import { RuntimeClientError } from './runtime-client'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'

describe('orca cli browser page targeting', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes explicit page ids to snapshot without resolving the current worktree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_snapshot', {
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['snapshot', '--page', 'page-1', '--json'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.snapshot', { page: 'page-1' })
  })

  it('resolves current worktree only when --page is combined with --worktree current', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_snapshot', {
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['snapshot', '--page', 'page-1', '--worktree', 'current', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.snapshot', {
      page: 'page-1',
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })

  it('passes page-targeted tab switches through without auto-scoping to the current worktree', async () => {
    queueFixtures(callMock, okFixture('req_switch', { switched: 2, browserPageId: 'page-2' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'switch', '--page', 'page-2', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabSwitch', {
      index: undefined,
      page: 'page-2'
    })
  })

  it('still resolves the current worktree when tab switch --page is combined with --worktree current', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_switch', { switched: 2, browserPageId: 'page-2' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'switch', '--page', 'page-2', '--worktree', 'current', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.tabSwitch', {
      index: undefined,
      page: 'page-2',
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })

  it('passes explicit profile ids to tab create', async () => {
    queueFixtures(callMock, okFixture('req_create', { browserPageId: 'page-3' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'tab',
        'create',
        '--url',
        'https://example.com',
        '--profile',
        'work',
        '--worktree',
        'all',
        '--json'
      ],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'browser.tabCreate',
      {
        url: 'https://example.com',
        worktree: undefined,
        profileId: 'work'
      },
      { timeoutMs: 60_000 }
    )
  })

  it('passes tab profile updates through by page id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_profile', {
        browserPageId: 'page-2',
        profileId: 'work',
        profileLabel: 'Work'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'set', '--page', 'page-2', '--profile', 'work', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabSetProfile', {
      page: 'page-2',
      profileId: 'work'
    })
  })

  it('shows tab profile labels in text mode when requested', async () => {
    queueFixtures(
      callMock,
      okFixture('req_list', {
        tabs: [
          {
            browserPageId: 'page-1',
            index: 0,
            url: 'https://example.com',
            title: 'Example',
            active: true,
            profileId: 'default',
            profileLabel: 'Default'
          },
          {
            browserPageId: 'page-2',
            index: 1,
            url: 'https://mail.example.com',
            title: 'Mail',
            active: false,
            profileId: 'work',
            profileLabel: 'Work'
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'list', '--show-profile', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabList', { worktree: undefined })
    expect(logSpy).toHaveBeenCalledWith(
      '* [0] page-1  Example — https://example.com  [Default]\n' +
        '  [1] page-2  Mail — https://mail.example.com  [Work]'
    )
  })

  it('shows a single tab by page id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_tab_show', {
        tab: {
          browserPageId: 'page-1',
          index: 0,
          url: 'https://example.com',
          title: 'Example',
          active: true,
          worktreeId: 'repo::/tmp/repo/feature',
          profileId: 'work',
          profileLabel: 'Work'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'show', '--page', 'page-1', '--json'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabShow', { page: 'page-1' })
  })

  it('resolves the current tab in a worktree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_tab_current', {
        tab: {
          browserPageId: 'page-2',
          index: 1,
          url: 'https://mail.example.com',
          title: 'Mail',
          active: true,
          worktreeId: 'repo::/tmp/repo/feature',
          profileId: 'default',
          profileLabel: 'Default'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'current', '--worktree', 'all', '--json'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabCurrent', { worktree: undefined })
  })
})

describe('orca cli browser tab profiles', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the profile bound to a tab', async () => {
    queueFixtures(
      callMock,
      okFixture('req_profile_show', {
        browserPageId: 'page-2',
        worktreeId: 'repo::/tmp/repo/feature',
        profileId: 'work',
        profileLabel: 'Work'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'show', '--page', 'page-2', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabProfileShow', { page: 'page-2' })
  })

  it('switches a tab back to the default profile', async () => {
    queueFixtures(
      callMock,
      okFixture('req_profile_default', {
        browserPageId: 'page-2',
        profileId: 'default',
        profileLabel: 'Default'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'use-default', '--page', 'page-2', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabSetProfile', {
      page: 'page-2',
      profileId: 'default'
    })
  })

  it('clones a tab into a different profile', async () => {
    queueFixtures(
      callMock,
      okFixture('req_profile_clone', {
        browserPageId: 'page-9',
        sourceBrowserPageId: 'page-2',
        profileId: 'work',
        profileLabel: 'Work'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'clone', '--page', 'page-2', '--profile', 'work', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabProfileClone', {
      page: 'page-2',
      profileId: 'work'
    })
  })
})

describe('orca cli browser tab profiles', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists browser tab profiles', async () => {
    queueFixtures(
      callMock,
      okFixture('req_profiles', {
        profiles: [
          { id: 'default', scope: 'default', label: 'Default', partition: 'persist:orca-browser' },
          {
            id: 'work',
            scope: 'isolated',
            label: 'Work',
            partition: 'persist:orca-browser-session-work'
          }
        ]
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'profile', 'list', '--json'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.profileList')
  })

  it('reports an empty browser tab profile list with a friendly message', async () => {
    queueFixtures(callMock, okFixture('req_profiles', { profiles: [] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'profile', 'list'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.profileList')
    expect(logSpy).toHaveBeenCalledWith('No browser profiles found.')
  })

  it('creates isolated browser tab profiles by default', async () => {
    queueFixtures(
      callMock,
      okFixture('req_profile_create', {
        profile: {
          id: 'work',
          scope: 'isolated',
          label: 'Work',
          partition: 'persist:orca-browser-session-work'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'create', '--label', 'Work', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.profileCreate', {
      label: 'Work',
      scope: 'isolated'
    })
  })

  it('forwards --scope imported through to the runtime', async () => {
    queueFixtures(
      callMock,
      okFixture('req_profile_create', {
        profile: {
          id: 'imp',
          scope: 'imported',
          label: 'From Chrome',
          partition: 'persist:orca-browser-session-imp'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'create', '--label', 'From Chrome', '--scope', 'imported', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith('browser.profileCreate', {
      label: 'From Chrome',
      scope: 'imported'
    })
  })

  it('rejects unknown --scope values instead of silently defaulting to isolated', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'create', '--label', 'Work', '--scope', 'isloated'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('--scope must be "isolated" or "imported"')
  })

  it('surfaces a runtime error if the registry refuses to create a profile', async () => {
    queueFixtures(callMock, okFixture('req_profile_create', { profile: null }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['tab', 'profile', 'create', '--label', 'Bogus'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to create browser profile (label=Bogus, scope=isolated)'
    )
  })

  it('deletes browser tab profiles by id', async () => {
    queueFixtures(callMock, okFixture('req_profile_delete', { deleted: true, profileId: 'work' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'delete', '--profile', 'work', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.profileDelete', { profileId: 'work' })
  })

  it('reports a not-deleted profile in text mode without throwing', async () => {
    queueFixtures(
      callMock,
      okFixture('req_profile_delete', { deleted: false, profileId: 'default' })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'profile', 'delete', '--profile', 'default'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledWith('browser.profileDelete', { profileId: 'default' })
    expect(logSpy).toHaveBeenCalledWith('Profile default was not deleted')
  })
})

describe('orca cli browser waits and viewport flags', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives selector waits an explicit RPC timeout budget', async () => {
    queueFixtures(callMock, okFixture('req_wait', { ok: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['wait', '--selector', '#ready', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.wait',
      {
        selector: '#ready',
        timeout: undefined,
        text: undefined,
        url: undefined,
        load: undefined,
        fn: undefined,
        state: undefined,
        worktree: undefined
      },
      { timeoutMs: 60_000 }
    )
  })

  it('extends selector wait RPC timeout when the user passes --timeout', async () => {
    queueFixtures(callMock, okFixture('req_wait', { ok: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['wait', '--selector', '#ready', '--timeout', '12000', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.wait',
      {
        selector: '#ready',
        timeout: 12000,
        text: undefined,
        url: undefined,
        load: undefined,
        fn: undefined,
        state: undefined,
        worktree: undefined
      },
      { timeoutMs: 17000 }
    )
  })

  it('does not tell users Orca is down for a generic runtime timeout', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeClientError(
        'runtime_timeout',
        'Timed out waiting for the Orca runtime to respond.'
      )
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['wait', '--selector', '#ready', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(errorSpy).toHaveBeenCalledWith('Timed out waiting for the Orca runtime to respond.')
  })

  it('passes the mobile viewport flag through to browser.viewport', async () => {
    queueFixtures(
      callMock,
      okFixture('req_viewport', {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'viewport',
        '--width',
        '375',
        '--height',
        '812',
        '--scale',
        '2',
        '--mobile',
        '--worktree',
        'all',
        '--json'
      ],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith('browser.viewport', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
      worktree: undefined
    })
  })
})
