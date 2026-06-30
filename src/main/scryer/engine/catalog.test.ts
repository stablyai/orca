import { describe, expect, it } from 'vitest'
import {
  ALL_SCRYER_OPERATION_IDS,
  createDefaultScryerOperationCatalog,
  createScryerOperationCatalog
} from './catalog'

describe('Scryer operation catalog', () => {
  it('registers every upstream-aligned operation id with a valid production contract', () => {
    const catalog = createDefaultScryerOperationCatalog()

    expect(
      catalog
        .listOperationContracts()
        .map((contract) => contract.id)
        .sort()
    ).toEqual([...ALL_SCRYER_OPERATION_IDS].sort())
    expect(catalog.validateCatalog()).toEqual({ ok: true, errors: [] })
    expect(catalog.listOperationContracts().some((contract) => contract.transports.test)).toBe(
      false
    )
  })

  it('rejects duplicate ids, missing anchors, and invalid transport metadata', () => {
    const base = createDefaultScryerOperationCatalog().getOperationContract('scryer.model.read')!
    const catalog = createScryerOperationCatalog()

    catalog.registerOperation(base)
    catalog.registerOperation({
      ...base,
      upstream: [],
      transports: { test: { enabled: true } }
    })

    const result = catalog.validateCatalog()

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_operation_id' }),
        expect.objectContaining({ code: 'missing_upstream_anchor' }),
        expect.objectContaining({ code: 'invalid_transport_metadata' }),
        expect.objectContaining({ code: 'test_transport_not_allowed' })
      ])
    )
  })

  it('allows test transport only when explicitly enabled for a test catalog', () => {
    const base = createDefaultScryerOperationCatalog().getOperationContract('scryer.model.read')!
    const catalog = createScryerOperationCatalog()
    catalog.registerOperation({
      ...base,
      policy: {
        ...base.policy,
        authorization: {
          ...('branches' in base.policy
            ? base.policy.branches[0].policy.authorization
            : base.policy.authorization),
          transports: ['test']
        }
      },
      transports: { test: { enabled: true } }
    })

    expect(catalog.validateCatalog().errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'test_transport_not_allowed' })])
    )
    expect(
      catalog
        .validateCatalog({ allowTestTransport: true })
        .errors.some((error) => error.code === 'test_transport_not_allowed')
    ).toBe(false)
  })
})
