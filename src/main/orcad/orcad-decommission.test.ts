import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const persistAcceptance = vi.hoisted(() => vi.fn())
const validateTransaction = vi.hoisted(() => vi.fn())
vi.mock('./orcad-decommission-acceptance', () => ({
  persistOrcadDecommissionAcceptance: persistAcceptance,
  validateOrcadDecommissionTransaction: validateTransaction
}))

import { configureOrcadDecommission, requestOrcadDecommission } from './orcad-decommission'

beforeEach(() => {
  validateTransaction.mockReturnValue({ transactionSnapshot: 'validated-transaction' })
})

afterEach(() => {
  configureOrcadDecommission(null)
  persistAcceptance.mockReset()
  validateTransaction.mockReset()
})

describe('orcad decommission adapter', () => {
  it('returns the host adapter verdict', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)

    await expect(requestOrcadDecommission('0.2.0+new', '0.2.0+new')).resolves.toEqual({
      outcome: 'accepted'
    })
    expect(adapter).toHaveBeenCalledOnce()
  })

  it('fails closed outside a configured orcad runtime', async () => {
    await expect(requestOrcadDecommission('0.2.0+new', '0.2.0+new')).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unavailable'
    })
  })

  it('does not fence a runtime that differs from the activation record', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)

    await expect(requestOrcadDecommission('0.2.0+old', '0.3.0+new')).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_version_mismatch'
    })
    expect(adapter).not.toHaveBeenCalled()
  })

  it('persists and echoes the durable transaction receipt after admission is fenced', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)
    const transactionId = 'b407cda3-44bd-44d8-b75a-8268c18035b1'

    await expect(
      requestOrcadDecommission('0.2.0+new', '0.2.0+new', transactionId)
    ).resolves.toEqual({ outcome: 'accepted', transactionId })
    expect(persistAcceptance).toHaveBeenCalledWith(
      transactionId,
      '0.2.0+new',
      undefined,
      'validated-transaction'
    )
    expect(validateTransaction).toHaveBeenCalledWith(transactionId, '0.2.0+new')
    expect(validateTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.mock.invocationCallOrder[0]
    )
    expect(adapter.mock.invocationCallOrder[0]).toBeLessThan(
      persistAcceptance.mock.invocationCallOrder[0]
    )
  })

  it('rejects an invalid transaction without invoking native retirement', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)
    validateTransaction.mockImplementation(() => {
      throw new Error('transaction replaced')
    })
    await expect(
      requestOrcadDecommission('version', 'version', 'transaction')
    ).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_transaction_unverifiable'
    })
    expect(adapter).not.toHaveBeenCalled()
    expect(persistAcceptance).not.toHaveBeenCalled()
  })

  it('reports an unverifiable receipt without claiming admission stayed open', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)
    persistAcceptance.mockImplementation(() => {
      throw new Error('disk unavailable')
    })

    await expect(
      requestOrcadDecommission('0.2.0+new', '0.2.0+new', 'b407cda3-44bd-44d8-b75a-8268c18035b1')
    ).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_receipt_unverifiable'
    })
  })
})
