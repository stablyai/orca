import { describe, expect, it } from 'vitest'
import { readOrcadBunSshTestFile } from './orcad-bun-ssh-test-file.mjs'

describe('orcad Bun SSH test-file forwarding', () => {
  it('accepts the pnpm separator before the selected test', () => {
    expect(readOrcadBunSshTestFile(['--', 'tests/e2e/lifecycle.spec.ts'], 'fallback.spec.ts')).toBe(
      'tests/e2e/lifecycle.spec.ts'
    )
  })

  it('accepts a directly forwarded selected test', () => {
    expect(readOrcadBunSshTestFile(['tests/e2e/lifecycle.spec.ts'], 'fallback.spec.ts')).toBe(
      'tests/e2e/lifecycle.spec.ts'
    )
  })

  it('uses the default when no selected test follows the separator', () => {
    expect(readOrcadBunSshTestFile(['--'], 'fallback.spec.ts')).toBe('fallback.spec.ts')
  })
})
