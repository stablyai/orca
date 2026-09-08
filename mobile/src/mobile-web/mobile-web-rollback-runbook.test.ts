import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runbook = readFileSync(
  new URL('../../../docs/reference/mobile-hybrid-webview-rollback.md', import.meta.url),
  'utf8'
)
const shellSource = readFileSync(
  new URL('./MobileWebHybridShellPresentation.tsx', import.meta.url),
  'utf8'
)

describe('mobile hybrid rollback runbook', () => {
  it('keeps Desktop package and native store rollback separate', () => {
    expect(runbook).toContain('## Desktop Web-Package Incident')
    expect(runbook).toContain('## Native-Shell or Store-Release Incident')
    expect(runbook).toContain('A Desktop package rollback cannot repair native pairing')
  })

  it('documents the two automatic recovery moves and no manual controls', () => {
    expect(runbook).toContain('The shell has no recovery controls')
    expect(runbook).toContain("deletes the host's cached generation")
    expect(runbook).toContain('restarts the view in place')
    // Support still needs a way off a broken host, and the header button is it.
    expect(runbook).toContain('**Hosts**')
    expect(shellSource).toContain('accessibilityLabel="Show paired hosts"')
    for (const retired of ['Use last version', 'mobile-web-recovery-']) {
      expect(runbook).not.toContain(retired)
      expect(shellSource).not.toContain(retired)
    }
  })

  it('forbids manual cache mutation and limits diagnostics', () => {
    expect(runbook).toContain('There is no\n  activation file to edit')
    expect(runbook).toContain('The Desktop must stop serving the rejected build ID.')
    expect(runbook).toContain('Do not request pairing credentials')
    expect(runbook).toContain('Twelve-character package build prefix and bridge version.')
  })
})
