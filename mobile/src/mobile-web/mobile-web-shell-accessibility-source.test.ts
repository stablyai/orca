import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shellSource = readFileSync(
  new URL('./MobileWebHybridShellPresentation.tsx', import.meta.url),
  'utf8'
)
const progressSource = readFileSync(
  new URL('./MobileWebPackageProgress.tsx', import.meta.url),
  'utf8'
)

describe('mobile web shell accessibility', () => {
  it('keeps shell navigation controls named and exposed as buttons', () => {
    expect(shellSource).toMatch(
      /accessibilityLabel="Back"\s+accessibilityRole="button"[\s\S]*?onPress=\{onBack\}/
    )
    expect(shellSource).toMatch(
      /accessibilityLabel="Show paired hosts"\s+accessibilityRole="button"[\s\S]*?>\s+<Text[^>]*>Hosts/
    )
  })

  it('announces status and warnings', () => {
    expect(shellSource).toMatch(/accessibilityLiveRegion="polite"[\s\S]*?\{statusLine\}/)
    expect(shellSource).toContain("accessibilityRole={packageWarning ? 'alert' : undefined}")
    expect(shellSource).toContain('accessibilityRole="alert"')
    expect(progressSource).toContain('accessibilityRole="progressbar"')
    expect(progressSource).toContain('accessibilityLiveRegion="polite"')
  })

  it('keeps implementation vocabulary out of the shell copy', () => {
    for (const source of [shellSource, progressSource]) {
      for (const banned of [
        'verified',
        'cache',
        'hosted session',
        'workspace interface',
        'workspace UI',
        'desktop-served'
      ]) {
        expect(renderedCopy(source).toLowerCase()).not.toContain(banned.toLowerCase())
      }
    }
  })
})

/** Quoted literals a user can read, excluding prop names and identifiers. */
function renderedCopy(source: string): string {
  return [...source.matchAll(/'([^'\n]*)'/g), ...source.matchAll(/`([^`\n]*)`/g)]
    .map((match) => match[1])
    .join('\n')
}
