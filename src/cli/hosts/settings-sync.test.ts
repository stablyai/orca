import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import { SETTINGS_SYNC_HANDLERS } from './settings-sync'

const thisComputer = vi.hoisted(() => ({ call: vi.fn(), isRemote: false }))
vi.mock('../workspaces/worktree-parent-fields', () => ({
  callerOrcaClient: () => thisComputer
}))

const paired = { call: vi.fn(), isRemote: true, environmentSelector: 'work-mac' }

function ok<T>(result: T) {
  return { id: '1', ok: true as const, result, _meta: { runtimeId: 'r' } }
}

async function run(command: 'settings push' | 'settings pull', flags = new Map()) {
  await SETTINGS_SYNC_HANDLERS[command]?.({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only call, isRemote and environmentSelector.
    client: paired as unknown as RuntimeClient,
    flags,
    cwd: '/',
    json: true
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  thisComputer.call.mockReset()
  paired.call.mockReset()
})

describe('orca settings push and pull', () => {
  it('pull reads the paired Orca and writes this computer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    paired.call.mockResolvedValueOnce(ok({ settings: { theme: 'dark' } }))
    thisComputer.call.mockResolvedValueOnce(ok({ changed: ['theme'], skipped: [] }))

    await run('settings pull', new Map([['dry-run', true]]))

    expect(paired.call).toHaveBeenCalledWith('settings.exportPortable', undefined)
    expect(thisComputer.call).toHaveBeenCalledWith('settings.importPortable', {
      settings: { theme: 'dark' },
      dryRun: true
    })
  })

  it('names the computer whose Orca cannot take the settings', async () => {
    thisComputer.call.mockResolvedValueOnce(ok({ settings: { theme: 'dark' } }))
    paired.call.mockRejectedValueOnce(new RuntimeClientError('method_not_found', 'Unknown method'))

    await expect(run('settings push')).rejects.toThrow(
      'Orca on work-mac cannot copy settings yet. Update Orca there and try again.'
    )
  })
})
