import { describe, expect, it } from 'vitest'
import {
  ALL_SCRYER_OPERATION_IDS,
  createDefaultScryerOperationCatalog,
  createScryerOperationCatalog
} from './catalog'
import { operationSchemas } from './schemas'

const DECISION_31_READ_OPERATION_IDS = [
  'scryer.model.read',
  'scryer.model.search',
  'scryer.model.query',
  'scryer.rules.read',
  'scryer.codebase.read'
] as const

const DECISION_31_EXPECTED_ERRORS = {
  'scryer.model.read': [
    'invalid_input',
    'incompatible_model',
    'io_error',
    'internal_error',
    'not_found'
  ],
  'scryer.model.search': ['invalid_input', 'incompatible_model', 'io_error', 'internal_error'],
  'scryer.model.query': [
    'invalid_input',
    'incompatible_model',
    'io_error',
    'internal_error',
    'not_found'
  ],
  'scryer.rules.read': ['invalid_input', 'internal_error'],
  'scryer.codebase.read': ['invalid_input', 'io_error', 'internal_error']
} satisfies Record<(typeof DECISION_31_READ_OPERATION_IDS)[number], string[]>

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

  it('gates #31 read operations on executable catalog contracts and explicit schemas', () => {
    const catalog = createDefaultScryerOperationCatalog()

    for (const operationId of DECISION_31_READ_OPERATION_IDS) {
      const contract = catalog.getOperationContract(operationId)
      expect(contract, `${operationId} must be registered`).toBeTruthy()
      expect(String(contract!.execute)).not.toContain('registered but not implemented')
      expect(contract!.policy).toBeTruthy()
      expect(contract!.upstream.length).toBeGreaterThan(0)
      expect(contract!.transports.cli).toBeTruthy()
      expect(contract!.transports.ipc).toBeTruthy()
      expect(Object.keys(contract!.errors).sort()).toEqual(
        DECISION_31_EXPECTED_ERRORS[operationId].sort()
      )
      expect(contract!.successSchema).toBe(operationSchemas[operationId].success)
      expect(contract!.successSchema).not.toBe(operationSchemas['scryer.model.health'].success)
      expect(contract!.successSchema.safeParse({ arbitrary: 'generic-record' }).success).toBe(
        false
      )
    }
  })
})
