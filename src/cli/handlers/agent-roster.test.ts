import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, constructorMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  constructorMock: vi.fn()
}))

vi.mock('../runtime-client', async () => {
  class RuntimeClient {
    call = callMock

    constructor(...args: unknown[]) {
      constructorMock(...args)
    }
  }

  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')
  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { buildTuiAgentRoster } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

const SETTINGS: Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'> = {
  defaultTuiAgent: 'claude',
  disabledTuiAgents: ['codex']
}

const ROSTER = buildTuiAgentRoster(SETTINGS)

describe('orca agent roster', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    constructorMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  it('reads settings and prints exactly the roster object with --json', async () => {
    queueFixtures(callMock, okFixture('req_settings_get', { settings: SETTINGS }))

    await main(['agent', 'roster', '--json'])

    expect(callMock).toHaveBeenCalledOnce()
    expect(callMock).toHaveBeenCalledWith('settings.get')
    const printed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))
    expect(Object.keys(printed)).toEqual(['enabled', 'disabled', 'default'])
    expect(printed).toEqual(ROSTER)
  })

  it('uses the selected paired runtime and labels configuration output', async () => {
    queueFixtures(callMock, okFixture('req_settings_get', { settings: SETTINGS }))

    await main(['agent', 'roster', '--pairing-code', 'paired-host'])

    expect(constructorMock.mock.calls.at(-1)?.slice(0, 4)).toEqual([
      undefined,
      undefined,
      'paired-host',
      undefined
    ])
    expect(callMock).toHaveBeenCalledWith('settings.get')
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0])
    expect(output).toContain('Enabled (configured; not detected/installed):')
    expect(output).toContain('Disabled: codex')
    expect(output).toContain('Default: claude')
  })
})
