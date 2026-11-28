import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { TERMINAL_HANDLERS } from './terminal'
import { TERMINAL_RENAME_IF_MANUAL_TITLE_RUNTIME_CAPABILITY } from '../../shared/terminal/runtime-policy/terminal-runtime-capabilities'

function fakeClient(runtime: { reachable: boolean; capabilities?: string[] }) {
  const call = vi.fn(async () => ({
    id: '1',
    ok: true,
    result: { rename: { handle: 'term_1', tabId: 'tab_1', title: 'Fix login' } }
  }))
  const getCliStatus = vi.fn(async () => ({ result: { runtime } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only call and getCliStatus.
  const client = { call, getCliStatus, isRemote: false } as unknown as RuntimeClient
  return { client, call }
}

function rename(client: RuntimeClient, flags: [string, string][]): Promise<void> {
  return TERMINAL_HANDLERS['terminal rename']!({
    flags: new Map([['terminal', 'term_1'], ['title', 'Fix login'], ...flags]),
    client,
    cwd: '/',
    json: true
  })
}

describe('terminal rename --if-manual-title', () => {
  it('refuses before dispatch when the host does not advertise the capability', async () => {
    const { client, call } = fakeClient({ reachable: true, capabilities: [] })
    await expect(rename(client, [['if-manual-title', '']])).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses before dispatch when the host is unreachable', async () => {
    const { client, call } = fakeClient({ reachable: false })
    await expect(rename(client, [['if-manual-title', 'Old']])).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('sends ifManualTitle when the host advertises the capability', async () => {
    const { client, call } = fakeClient({
      reachable: true,
      capabilities: [TERMINAL_RENAME_IF_MANUAL_TITLE_RUNTIME_CAPABILITY]
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await rename(client, [['if-manual-title', '']])
    log.mockRestore()
    expect(call).toHaveBeenCalledWith('terminal.rename', {
      terminal: 'term_1',
      title: 'Fix login',
      ifManualTitle: ''
    })
  })

  it('does not check capabilities for a plain rename', async () => {
    const { client, call } = fakeClient({ reachable: false })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await rename(client, [])
    log.mockRestore()
    expect(call).toHaveBeenCalledWith('terminal.rename', { terminal: 'term_1', title: 'Fix login' })
  })
})
