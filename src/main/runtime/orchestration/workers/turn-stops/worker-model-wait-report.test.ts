import { describe, expect, it } from 'vitest'
import { modelWaitLastSeenLine } from './worker-model-wait-report'

describe('the model-wait notice', () => {
  it('never copies a capability or credential from the worker screen into coordinator mail', () => {
    const capability = `dcap_${'a1B2'.repeat(8)}`
    const key = `sk-ant-api03-${'x9Y8'.repeat(16)}`
    const line = modelWaitLastSeenLine(`  export ORCA_DISPATCH=${capability}\n  KEY=${key}  `)
    expect(line).not.toContain(capability)
    expect(line).not.toContain(key)
    expect(line).not.toContain('\n')
  })
})
