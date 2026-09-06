import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runbook = readFileSync(
  new URL('../../../docs/reference/mobile-hybrid-webview-rollback.md', import.meta.url),
  'utf8'
)
const recoveryActions = readFileSync(
  new URL('./MobileWebRecoveryActions.tsx', import.meta.url),
  'utf8'
)

describe('mobile hybrid rollback runbook', () => {
  it('keeps Desktop package and native store rollback separate', () => {
    expect(runbook).toContain('## Desktop Web-Package Incident')
    expect(runbook).toContain('## Native-Shell or Store-Release Incident')
    expect(runbook).toContain('A Desktop package rollback cannot repair native pairing')
  })

  it('documents every native recovery action by its product label', () => {
    expect(recoveryActions).toContain('accessibilityLabel="Retry"')
    expect(runbook).toContain('**Retry**')
    for (const label of ['Use last version', 'Reset', 'Switch hosts']) {
      expect(recoveryActions).toContain(`label: '${label}'`)
      expect(runbook).toContain(`**${label}**`)
    }
  })

  it('forbids manual cache mutation and limits diagnostics', () => {
    expect(runbook).toContain('Never edit `activation.json`')
    expect(runbook).toContain('The Desktop must stop serving the rejected build ID.')
    expect(runbook).toContain('Do not request pairing credentials')
    expect(runbook).toContain('Twelve-character package build prefix and bridge version.')
  })
})
