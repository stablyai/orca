import { describe, expect, it } from 'vitest'
import { groupAndroidReleaseNotes } from './group-android-release-notes.mjs'

const NOTES = `## What's Changed
* fix(editor): cancel paste when its target model changes by @OrcaWin in https://github.com/stablyai/orca/pull/34904
* feat(mobile): localize app screens by @OrcaWin in https://github.com/stablyai/orca/pull/35498
* feat(wsl): offer Git for Windows by @nwparker in https://github.com/stablyai/orca/pull/33097
* perf(browser): reuse tab snapshots by @OrcaWin in https://github.com/stablyai/orca/pull/35327
* Prioritize direct URL navigation by @AmethystLiang in https://github.com/stablyai/orca/pull/35239
* test: remove 17 low-value cases by @OrcaWin in https://github.com/stablyai/orca/pull/35394

## New Contributors
* @Pr1p made their first contribution in https://github.com/stablyai/orca/pull/34833

**Full Changelog**: https://github.com/stablyai/orca/compare/a...b
`

describe('groupAndroidReleaseNotes', () => {
  it('groups bullets by conventional prefix, then scope', () => {
    const out = groupAndroidReleaseNotes(NOTES)
    expect(out).toContain('### New features')
    expect(out).toContain('#### mobile')
    expect(out).toContain('#### wsl')
    expect(out).toContain('### Bug fixes')
    expect(out).toContain('### Performance')
    expect(out).toContain('### Tests')
    expect(out).toContain('### Other changes')
  })

  it('keeps every bullet and preserves order within a group', () => {
    const out = groupAndroidReleaseNotes(NOTES)
    const before = NOTES.match(/^\* /gm).length
    const after = out.match(/^\* /gm).length
    expect(after).toBe(before)
    expect(out.indexOf('localize app screens')).toBeLessThan(out.indexOf('offer Git for Windows'))
  })

  it('keeps headings and the Full Changelog trailer outside the sections', () => {
    const out = groupAndroidReleaseNotes(NOTES)
    expect(out).toContain('## New Contributors')
    expect(out).toContain('@Pr1p made their first contribution')
    expect(out).toContain('**Full Changelog**')
    expect(out.indexOf('### Other changes')).toBeLessThan(out.indexOf('## New Contributors'))
  })

  it('returns the input unchanged when there are no bullets to group', () => {
    const body = 'Orca Mobile Android mobile-android-v0.0.62\n'
    expect(groupAndroidReleaseNotes(body)).toBe(body)
  })
})
