import { expect, it } from 'vitest'
import { inspectPtyCreateOperation } from './pty-create-operation-inspection'

const operationId = 'a'.repeat(43)
const params = { agentSessionCreateOperationId: operationId }
const result = {
  id: 'terminal',
  incarnationId: 'incarnation',
  sourceActivation: { secret: 'not returned' }
}

it('returns only historical terminal identity without exposing activation data', async () => {
  const operation = Promise.resolve(result)
  const ledger = new Map([[operationId, operation]])
  expect(await inspectPtyCreateOperation(params, ledger)).toEqual({
    version: 1,
    operationId,
    outcome: 'recorded',
    terminalId: 'terminal',
    incarnationId: 'incarnation'
  })
  expect(ledger.get(operationId)).toBe(operation)
})

it('keeps missing and failed creation evidence unverifiable without adding ledger entries', async () => {
  const ledger = new Map<string, Promise<typeof result>>()
  expect(await inspectPtyCreateOperation(params, ledger)).toMatchObject({ outcome: 'unverifiable' })
  expect(ledger.size).toBe(0)
  ledger.set(operationId, Promise.reject(new Error('native creation uncertain')))
  expect(await inspectPtyCreateOperation(params, ledger)).toMatchObject({ outcome: 'unverifiable' })
  expect(ledger.size).toBe(1)
})

it.each(['deleted', 'replaced'])(
  'rejects evidence %s while waiting for creation',
  async (change) => {
    const pending = Promise.withResolvers<typeof result>()
    const ledger = new Map([[operationId, pending.promise]])
    const inspection = inspectPtyCreateOperation(params, ledger)
    if (change === 'deleted') {
      ledger.delete(operationId)
    } else {
      ledger.set(operationId, Promise.resolve(result))
    }
    pending.resolve(result)
    expect(await inspection).toMatchObject({ outcome: 'unverifiable' })
  }
)

it.each([undefined, '', 'short', 'a'.repeat(44), '/'.repeat(43)])(
  'refuses invalid operation identity %s',
  async (id) => {
    await expect(
      inspectPtyCreateOperation({ agentSessionCreateOperationId: id }, new Map())
    ).rejects.toThrow('operation_invalid')
  }
)
