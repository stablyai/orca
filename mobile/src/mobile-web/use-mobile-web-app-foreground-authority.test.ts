import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('mobile web app foreground authority', () => {
  it('reports native lifecycle transitions to the broker', () => {
    const source = readFileSync(
      new URL('./use-mobile-web-app-foreground-authority.ts', import.meta.url),
      'utf8'
    )

    expect(source).toContain("AppState.addEventListener('change'")
    expect(source).toContain(
      "foregroundAuthorityRef.current?.updateAppForegroundState(nextState === 'active')"
    )
    expect(source).toContain('subscription.remove()')
  })
})
