// PROVIDER IPC: safe results and SANITIZED diagnostics.
//
// Storage failures on this path can carry the key path, the safeStorage/OS
// failure detail, or — on a decrypt path — fragments of the value itself. The
// IPC result already carries the truthful outcome, so a raw error object adds
// nothing the caller needs and everything an attacker would want. Console output
// is captured in logs and bug reports, so "it's only a log line" is not a
// mitigation.
//
// Every failure below injects SENTINEL values into the thrown error and asserts
// they appear in neither the IPC result nor any console diagnostic.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const saveKey = vi.fn()
const clearKey = vi.fn()
const hasKey = vi.fn()

vi.mock('../audited-workflow/audited-codex-provider-key-store', () => ({
  saveAuditedCodexProviderKey: (...args: unknown[]) => saveKey(...args),
  clearAuditedCodexProviderKey: (...args: unknown[]) => clearKey(...args),
  hasAuditedCodexProviderKey: (...args: unknown[]) => hasKey(...args)
}))

import { registerAuditedCodexProviderHandlers } from './audited-workflow-codex-provider'

// Values that must never escape: a filesystem path, a secret, and an OS detail.
const SENTINEL_PATH = 'C:\\Users\\victim\\.orca\\audited-workflow-codex-provider-token.enc'
const SENTINEL_SECRET = 'sk-SENTINEL-provider-secret-value-0123456789'
const SENTINEL_OS_DETAIL = 'EACCES: permission denied, open'

function sentinelError(): Error {
  const error = new Error(
    `${SENTINEL_OS_DETAIL} '${SENTINEL_PATH}' while encrypting ${SENTINEL_SECRET}`
  )
  // A realistic errno-style shape, so a naive logger would surface more than the
  // message alone.
  Object.assign(error, { code: 'EACCES', path: SENTINEL_PATH, secret: SENTINEL_SECRET })
  return error
}

const SENTINELS = [SENTINEL_PATH, SENTINEL_SECRET, SENTINEL_OS_DETAIL, 'EACCES']

function invoke(channel: string, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({}, args)
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>

/** Everything written to the console during a case, as one string. */
function consoleOutput(): string {
  return [...consoleErrorSpy.mock.calls, ...consoleWarnSpy.mock.calls]
    .flat()
    .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    .join('\n')
}

function expectNoSentinels(text: string): void {
  for (const sentinel of SENTINELS) {
    expect(text).not.toContain(sentinel)
  }
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  hasKey.mockReturnValue(false)
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  registerAuditedCodexProviderHandlers()
})

afterEach(() => {
  consoleErrorSpy.mockRestore()
  consoleWarnSpy.mockRestore()
})

describe('status', () => {
  it('reports only the two safe facts', () => {
    hasKey.mockReturnValue(true)
    expect(invoke('auditedWorkflow:getCodexProviderStatus')).toEqual({
      settingsId: 'byesu',
      keyConfigured: true
    })
  })

  it('reports not-configured with no key', () => {
    expect(invoke('auditedWorkflow:getCodexProviderStatus')).toEqual({
      settingsId: null,
      keyConfigured: false
    })
  })

  it('never leaks the endpoint', () => {
    hasKey.mockReturnValue(true)
    expect(JSON.stringify(invoke('auditedWorkflow:getCodexProviderStatus'))).not.toContain(
      'byesu.com'
    )
  })

  it('falls back to a safe status when the storage probe throws', () => {
    hasKey.mockImplementation(() => {
      throw sentinelError()
    })

    const result = invoke('auditedWorkflow:getCodexProviderStatus')

    expect(result).toEqual({ settingsId: null, keyConfigured: false })
    expectNoSentinels(JSON.stringify(result))
    expectNoSentinels(consoleOutput())
  })
})

describe('save — storage failure', () => {
  it('returns a safe status and logs no sentinel', () => {
    saveKey.mockImplementation(() => {
      throw sentinelError()
    })

    const result = invoke('auditedWorkflow:saveCodexProviderKey', { apiKey: 'k' })

    expect(result).toEqual({ settingsId: null, keyConfigured: false })
    expectNoSentinels(JSON.stringify(result))
    expectNoSentinels(consoleOutput())
  })

  it('logs a FIXED message, not the error object', () => {
    saveKey.mockImplementation(() => {
      throw sentinelError()
    })

    invoke('auditedWorkflow:saveCodexProviderKey', { apiKey: 'k' })

    // Exactly one argument — a raw error passed as a second argument is the
    // defect this asserts against.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy.mock.calls[0]).toHaveLength(1)
    expect(consoleErrorSpy.mock.calls[0]![0]).toBe(
      '[auditedWorkflow] Saving the Codex provider key failed.'
    )
  })

  it('never logs the submitted key itself', () => {
    saveKey.mockImplementation(() => {
      throw new Error('boom')
    })

    invoke('auditedWorkflow:saveCodexProviderKey', { apiKey: SENTINEL_SECRET })

    expect(consoleOutput()).not.toContain(SENTINEL_SECRET)
  })
})

describe('clear — storage failure', () => {
  it('returns a safe status and logs no sentinel', () => {
    clearKey.mockImplementation(() => {
      throw sentinelError()
    })

    const result = invoke('auditedWorkflow:clearCodexProviderKey')

    expect(result).toEqual({ settingsId: null, keyConfigured: false })
    expectNoSentinels(JSON.stringify(result))
    expectNoSentinels(consoleOutput())
  })

  it('logs a FIXED message, not the error object', () => {
    clearKey.mockImplementation(() => {
      throw sentinelError()
    })

    invoke('auditedWorkflow:clearCodexProviderKey')

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy.mock.calls[0]).toHaveLength(1)
  })
})

describe('parameter validation', () => {
  it('rejects a payload naming a provider rather than stripping it', () => {
    // .strict(): a renderer attempt to choose an endpoint is a hard error.
    expect(() =>
      invoke('auditedWorkflow:saveCodexProviderKey', {
        apiKey: 'k',
        settingsId: 'byesu',
        baseUrl: 'https://attacker.example/v1'
      })
    ).toThrow()
  })

  it('rejects a missing apiKey', () => {
    expect(() => invoke('auditedWorkflow:saveCodexProviderKey', {})).toThrow()
  })
})
