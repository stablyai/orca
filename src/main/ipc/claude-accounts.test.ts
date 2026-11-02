import { describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountService } from '../claude-accounts/service'
import { registerClaudeAccountHandlers } from './claude-accounts'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('./account-sign-in-link-opener', () => ({ openAccountSignInLink: vi.fn() }))

type Handler = (event: unknown, args: unknown) => unknown

function registeredHandler(channel: string): Handler {
  const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
  if (!call) {
    throw new Error(`Missing handler ${channel}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ipcMain.handle received this handler from registerClaudeAccountHandlers.
  return call[1] as Handler
}

describe('claudeAccounts:setAutoSwitch', () => {
  it('passes a boolean through and rejects anything else without touching the setting', async () => {
    const setAutoSwitch = vi.fn(async (enabled: boolean) => ({ enabled }))
    const members = { setWslSignInLinkOpener: vi.fn(), setAutoSwitch }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler under test touches only these two members.
    const claudeAccounts = members as unknown as ClaudeAccountService
    registerClaudeAccountHandlers(claudeAccounts)
    const handler = registeredHandler('claudeAccounts:setAutoSwitch')

    await expect(handler({}, { enabled: true })).resolves.toEqual({ enabled: true })
    expect(setAutoSwitch).toHaveBeenCalledExactlyOnceWith(true)

    for (const enabled of ['true', 1, null, undefined, {}]) {
      expect(() => handler({}, { enabled })).toThrow(TypeError)
    }
    expect(() => handler({}, undefined)).toThrow(TypeError)
    expect(setAutoSwitch).toHaveBeenCalledTimes(1)
  })
})
