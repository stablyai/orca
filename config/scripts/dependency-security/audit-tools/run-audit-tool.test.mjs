import { describe, expect, it, vi } from 'vitest'
import { runAuditTool } from './run-audit-tool.mjs'

describe('locked audit tool execution', () => {
  it('rejects an unknown executable before installing anything', () => {
    const run = vi.fn()
    expect(() => runAuditTool('../arbitrary-package', [], { run })).toThrow('Unknown audit tool')
    expect(run).not.toHaveBeenCalled()
  })
})
