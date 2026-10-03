import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeAccountController, type RuntimeAccountServices } from './runtime-account-controller'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'

const scope: CodexResetCreditExpectedScope = {
  accountId: 'account-1',
  accountRevision: 100,
  offerRevision: 'v1:test',
  target: { runtime: 'host', wslDistro: null }
}

describe('desktop approval before Codex reset', () => {
  const consume = vi.fn()
  const approve = vi.fn()
  let controller: RuntimeAccountController

  function configure(withApproval = true) {
    const services = {
      codexAccounts: {
        listAccounts: () => ({
          accounts: [{ id: scope.accountId, email: 'test@example.invalid', updatedAt: 100 }]
        }),
        consumeRateLimitResetCredit: consume
      },
      claudeAccounts: { listAccounts: () => ({ accounts: [] }) },
      rateLimits: {},
      ...(withApproval ? { approveCodexReset: approve } : {})
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the listed service methods are exercised; partial doubles prevent real account/provider access.
    controller.setServices(services as unknown as RuntimeAccountServices)
  }

  beforeEach(() => {
    controller = new RuntimeAccountController()
    consume.mockReset().mockResolvedValue({ outcome: 'reset', scope, codex: {}, rateLimits: {} })
    approve.mockReset().mockResolvedValue(true)
    configure()
  })

  it('does not call the reset service until the user approves', async () => {
    let answer: ((value: boolean) => void) | undefined
    approve.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    const pending = controller.requestCodexResetCredit('attempt-1', scope)
    expect(approve).toHaveBeenCalledWith(scope, 'test@example.invalid')
    expect(consume).not.toHaveBeenCalled()
    answer?.(true)
    await expect(pending).resolves.toMatchObject({ outcome: 'reset' })
    expect(consume).toHaveBeenCalledWith('attempt-1', scope)
  })

  it('refuses when user approval is declined', async () => {
    approve.mockResolvedValue(false)
    await expect(controller.requestCodexResetCredit('attempt-1', scope)).rejects.toThrow(
      'not granted'
    )
    expect(consume).not.toHaveBeenCalled()
  })

  it('refuses headless services without an approval callback', async () => {
    configure(false)
    await expect(controller.requestCodexResetCredit('attempt-1', scope)).rejects.toThrow('Headless')
    expect(consume).not.toHaveBeenCalled()
  })

  it('does not redeem when the dialog closes or fails', async () => {
    approve.mockRejectedValue(new Error('window closed'))
    await expect(controller.requestCodexResetCredit('attempt-1', scope)).rejects.toThrow(
      'window closed'
    )
    expect(consume).not.toHaveBeenCalled()
    approve.mockResolvedValue(true)
    await controller.requestCodexResetCredit('attempt-1', scope)
    expect(consume).toHaveBeenCalledOnce()
  })

  it('refuses an account revision change before prompting', async () => {
    await expect(
      controller.requestCodexResetCredit('attempt-1', { ...scope, accountRevision: 101 })
    ).rejects.toThrow('changed before approval')
    expect(approve).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
  })

  it('blocks concurrent dialogs and requests approval again on retry', async () => {
    let answer: ((value: boolean) => void) | undefined
    approve.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    const pending = controller.requestCodexResetCredit('attempt-1', scope)
    await expect(controller.requestCodexResetCredit('attempt-2', scope)).rejects.toThrow(
      'already pending'
    )
    answer?.(true)
    await pending
    await controller.requestCodexResetCredit('attempt-1', scope)
    expect(approve).toHaveBeenCalledTimes(2)
    expect(consume.mock.calls.map(([key]) => key)).toEqual(['attempt-1', 'attempt-1'])
  })

  it('preserves the existing service rejection if the scope changes during approval', async () => {
    consume.mockResolvedValue({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope,
      codex: {},
      rateLimits: {}
    })
    await expect(controller.requestCodexResetCredit('attempt-1', scope)).resolves.toMatchObject({
      reason: 'offerChanged'
    })
  })
})
