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

  it('sees static templates and every dynamic template part in visible calls', () => {
    const reports = candidates(
      'Sample.ts',
      'confirm(`Retry the sync`); alert(`Reconnect ${host} after ${attempts} attempts`);'
    )

    expect(reports.map(({ text, dynamic }) => ({ text, dynamic }))).toEqual([
      { text: 'Retry the sync', dynamic: false },
      { text: 'Reconnect', dynamic: true },
      { text: 'after', dynamic: true },
      { text: 'attempts', dynamic: true }
    ])
  })

  it('ignores nested class properties and translations while seeing sibling copy', () => {
    const reports = candidates(
      'Sample.tsx',
      [
        'const config = {',
        '  className: { label: "Hidden class copy" },',
        '  classNames: ["Hidden token", { title: "Hidden nested token" }],',
        '  title: `Connect ${host}`,',
        '  message: "Reconnect the host",',
        '  description: t("connection.ready", "Ready now")',
        '};',
        'export const view = <span>{t("connection.banner", { label: "Connection banner" })}</span>;'
      ].join('\n')
    )

    expect(reports.map(({ text, dynamic }) => ({ text, dynamic }))).toEqual([
      { text: 'Connect', dynamic: true },
      { text: 'Reconnect the host', dynamic: false }
    ])
  })

  it('keeps traversing calls and callbacks to find nested JSX attributes and text', () => {
    const reports = candidates(
      'Sample.tsx',
      `export function Sample() {
        return <div>{select(true, () => <button title={'Retry after reconnect'}>Reconnect now</button>)}</div>
      }`
    )

    expect(reports.map((report) => report.text)).toEqual(['Retry after reconnect', 'Reconnect now'])
  })
})

describe('localization coverage file skipping', () => {
  function skipped(relativePath) {
    return isSkippedFile(ROOT, `${ROOT}/${relativePath}`)
  }

  it('skips test-only modules that sit beside their spec', () => {
    expect(skipped('src/renderer/src/components/browser-pane/stream-test-harness.ts')).toBe(true)
    expect(skipped('src/renderer/src/runtime/browser-tab-creation-test-rig.ts')).toBe(true)
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
