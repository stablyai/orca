import { describe, expect, it } from 'vitest'

import { collectLocalizationCandidates } from './audit-localization-coverage.mjs'

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
