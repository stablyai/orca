import { describe, expect, it } from 'vitest'

import { collectLocalizationCandidates, isSkippedFile } from './audit-localization-coverage.mjs'

const ROOT = process.cwd()

function candidates(fileName, source) {
  return collectLocalizationCandidates(`${ROOT}/src/renderer/src/${fileName}`, source, ROOT)
}

describe('localization coverage candidates', () => {
  it('sees copy guarded by a nullish or logical fallback', () => {
    const reports = candidates(
      'Sample.tsx',
      `export function Sample({ label, connecting }) {
        return <span>{label ?? (connecting ? 'Connecting…' : 'Idle')}</span>
      }`
    )

    expect(reports.map((report) => report.text)).toEqual(['Connecting…', 'Idle'])
  })

  it('sees copy nested inside a conditional JSX guard', () => {
    const reports = candidates(
      'Sample.tsx',
      `export function Sample({ show }) {
        return <div>{show && <button aria-label="Retry the sync" />}</div>
      }`
    )

    expect(reports.map((report) => report.text)).toEqual(['Retry the sync'])
  })

  it('ignores literals used as comparison operands', () => {
    const reports = candidates(
      'Sample.tsx',
      `export function Sample({ phase }) {
        return <span>{phase === 'workspace conflict' ? phase : null}</span>
      }`
    )

    expect(reports).toEqual([])
  })
})

describe('localization coverage file skipping', () => {
  function skipped(relativePath) {
    return isSkippedFile(ROOT, `${ROOT}/${relativePath}`)
  }

  it('skips test-only modules that sit beside their spec', () => {
    expect(skipped('src/renderer/src/components/browser-pane/stream-test-harness.ts')).toBe(true)
    expect(skipped('src/renderer/src/hooks/ipc-events-test-fixtures.ts')).toBe(true)
    expect(skipped('src/renderer/src/lib/session-test-state.ts')).toBe(true)
    expect(skipped('src/renderer/src/store/slices/routing-fixture.ts')).toBe(true)
    expect(skipped('src/renderer/src/components/tab-bar/icon-stub.fixture.tsx')).toBe(true)
  })

  it('still scans shipped modules whose names merely mention a fixture concept', () => {
    expect(skipped('src/renderer/src/components/browser-pane/fixture-picker.tsx')).toBe(false)
    expect(skipped('src/renderer/src/components/settings/fixtures-panel.tsx')).toBe(false)
    expect(skipped('src/renderer/src/components/browser-pane/BrowserPane.tsx')).toBe(false)
  })
})
