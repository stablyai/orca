import { describe, expect, it } from 'vitest'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../../../../shared/artifacts'
import { ARTIFACT_METHODS } from './artifacts'

const validRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Report</h1>',
  contentType: 'text/html',
  fileName: 'report.html'
}

function writeSchema(name: string) {
  const method = ARTIFACT_METHODS.find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`Missing ${name} schema`)
  }
  return method.params
}

describe('artifact RPC schemas', () => {
  it('registers the local publish upsert', () => {
    expect(writeSchema('artifacts.publish').safeParse(validRequest).success).toBe(true)
  })

  it('rejects empty and oversized artifact requests', () => {
    const schema = writeSchema('artifacts.publish')
    expect(schema.safeParse({ ...validRequest, content: '' }).success).toBe(false)
    expect(
      schema.safeParse({ ...validRequest, content: 'x'.repeat(ARTIFACT_CLI_MAX_RPC_BYTES + 1) })
        .success
    ).toBe(false)
    expect(
      schema.safeParse({
        ...validRequest,
        content: '"'.repeat(Math.floor(ARTIFACT_CLI_MAX_RPC_BYTES / 2))
      }).success
    ).toBe(false)
  })
})
