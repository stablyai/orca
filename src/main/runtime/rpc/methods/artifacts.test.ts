import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_REQUEST_BYTES
} from '../../../../shared/artifacts'
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

  it('registers the persisted-link lookup', () => {
    const schema = writeSchema('artifacts.getPublishedLink')
    expect(schema.safeParse({ sourceKey: validRequest.sourceKey }).success).toBe(true)
    expect(schema.safeParse({ sourceKey: '' }).success).toBe(false)
  })

  it('rejects empty and oversized artifact requests', () => {
    const schema = writeSchema('artifacts.publish')
    expect(schema.safeParse({ ...validRequest, content: '' }).success).toBe(false)
    expect(
      schema.safeParse({ ...validRequest, content: 'x'.repeat(ARTIFACT_MAX_CONTENT_BYTES + 1) })
        .success
    ).toBe(false)
    expect(
      schema.safeParse({
        ...validRequest,
        content: '"'.repeat(ARTIFACT_MAX_CONTENT_BYTES + 1)
      }).success
    ).toBe(false)
  })

  it('accepts a 10 MiB UTF-8 artifact at the content boundary', () => {
    expect(
      writeSchema('artifacts.publish').safeParse({
        ...validRequest,
        content: 'a'.repeat(ARTIFACT_MAX_CONTENT_BYTES)
      }).success
    ).toBe(true)
  })

  it('measures the content boundary in UTF-8 bytes', () => {
    const euroCount = Math.floor(ARTIFACT_MAX_CONTENT_BYTES / 3)
    const asciiBytes = ARTIFACT_MAX_CONTENT_BYTES - euroCount * 3
    const exact = `${'€'.repeat(euroCount)}${'a'.repeat(asciiBytes)}`
    const oversized = `${exact}€`
    expect(new TextEncoder().encode(exact).byteLength).toBe(ARTIFACT_MAX_CONTENT_BYTES)
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(
      ARTIFACT_MAX_CONTENT_BYTES
    )
    expect(
      writeSchema('artifacts.publish').safeParse({ ...validRequest, content: exact }).success
    ).toBe(true)
    expect(
      writeSchema('artifacts.publish').safeParse({ ...validRequest, content: oversized }).success
    ).toBe(false)
  })

  it('allows JSON escaping within the bounded content request', () => {
    expect(
      writeSchema('artifacts.publish').safeParse({
        ...validRequest,
        content: '"'.repeat(Math.floor(ARTIFACT_MAX_CONTENT_BYTES / 2))
      }).success
    ).toBe(true)
  })

  it('rejects an escaped envelope beyond the request budget', () => {
    const content = '\u0000'.repeat(Math.ceil(ARTIFACT_MAX_REQUEST_BYTES / 6))
    expect(new TextEncoder().encode(content).byteLength).toBeLessThan(ARTIFACT_MAX_CONTENT_BYTES)
    expect(writeSchema('artifacts.publish').safeParse({ ...validRequest, content }).success).toBe(
      false
    )
  })
})
