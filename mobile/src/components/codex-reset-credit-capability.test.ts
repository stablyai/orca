import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_CODEX_RESET_CREDIT_CAPABILITY,
  readCodexResetCreditCapability
} from './codex-reset-credit-capability'

describe('readCodexResetCreditCapability', () => {
  it('enables reset only when the host explicitly advertises the contract', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { capabilities: ['mobile.tasks.v1', MOBILE_CODEX_RESET_CREDIT_CAPABILITY] }
    })

    await expect(readCodexResetCreditCapability({ sendRequest })).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledWith('status.get')
  })

  it.each([
    { ok: true, result: { capabilities: ['mobile.tasks.v1'] } },
    { ok: true, result: { capabilities: 'accounts.codex-reset-credit.v1' } },
    { ok: false, error: { code: 'old-host', message: 'unsupported' } }
  ])('fails closed for an unsupported or malformed host response', async (response) => {
    const sendRequest = vi.fn().mockResolvedValue(response)
    await expect(readCodexResetCreditCapability({ sendRequest })).resolves.toBe(false)
  })

  it('fails closed when the capability probe cannot complete', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('connection lost'))
    await expect(readCodexResetCreditCapability({ sendRequest })).resolves.toBe(false)
  })
})
