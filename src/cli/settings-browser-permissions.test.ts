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
import { okFixture, queueFixtures } from './test-fixtures'

describe('orca cli browser permission settings', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('gets browserInteractionMode through settings.get', async () => {
    queueFixtures(
      callMock,
      okFixture('req_settings_get', {
        settings: {
          browserInteractionMode: 'human',
          browserPermissionNoticePolicy: 'important-only'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['settings', 'get', '--key', 'browserInteractionMode', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('settings.get')
  })

  it('sets browserInteractionMode through settings.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_settings_set', {
        key: 'browserInteractionMode',
        value: 'agent'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['settings', 'set', '--key', 'browserInteractionMode', '--value', 'agent', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('settings.set', {
      key: 'browserInteractionMode',
      value: 'agent'
    })
  })

  it('rejects unsupported browser permission setting keys before RPC', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['settings', 'get', '--key', 'theme'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('lists remembered browser permission rules', async () => {
    queueFixtures(
      callMock,
      okFixture('req_browser_permissions_list', {
        mode: 'human',
        noticePolicy: 'important-only',
        rules: [
          {
            profileId: 'default',
            origin: 'https://app.slack.com',
            permission: 'notifications',
            action: 'allow'
          }
        ]
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['browser-permissions', 'list', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('browserPermissions.list', { profileId: undefined })
  })

  it('sets allow site rules', async () => {
    queueFixtures(
      callMock,
      okFixture('req_browser_permissions_allow', {
        origin: 'https://app.slack.com',
        profileId: 'default',
        permission: 'notifications',
        action: 'allow',
        rules: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'browser-permissions',
        'allow',
        '--origin',
        'https://app.slack.com',
        '--permission',
        'notifications',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('browserPermissions.set', {
      profileId: undefined,
      origin: 'https://app.slack.com',
      permission: 'notifications',
      action: 'allow'
    })
  })

  it('sets deny site rules for an explicit browser profile', async () => {
    queueFixtures(
      callMock,
      okFixture('req_browser_permissions_deny', {
        profileId: 'profile-1',
        origin: 'https://app.slack.com',
        permission: 'media',
        action: 'deny',
        rules: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'browser-permissions',
        'deny',
        '--origin',
        'https://app.slack.com',
        '--permission',
        'media',
        '--profile',
        'profile-1',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('browserPermissions.set', {
      profileId: 'profile-1',
      origin: 'https://app.slack.com',
      permission: 'media',
      action: 'deny'
    })
  })

  it('sets prompt site rules', async () => {
    queueFixtures(
      callMock,
      okFixture('req_browser_permissions_prompt', {
        profileId: 'default',
        origin: 'https://app.slack.com',
        permission: 'notifications',
        action: 'prompt',
        rules: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'browser-permissions',
        'prompt',
        '--origin',
        'https://app.slack.com',
        '--permission',
        'notifications',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('browserPermissions.set', {
      profileId: undefined,
      origin: 'https://app.slack.com',
      permission: 'notifications',
      action: 'prompt'
    })
  })

  it('removes remembered site rules', async () => {
    queueFixtures(
      callMock,
      okFixture('req_browser_permissions_remove', {
        origin: 'https://app.slack.com',
        profileId: 'default',
        permission: 'notifications',
        rules: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'browser-permissions',
        'remove',
        '--origin',
        'https://app.slack.com',
        '--permission',
        'notifications',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('browserPermissions.remove', {
      profileId: undefined,
      origin: 'https://app.slack.com',
      permission: 'notifications'
    })
  })
})
