import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

describe('Desktop build script dependencies', () => {
  it('keeps desktop and release build dependencies resolvable', () => {
    const scripts = packageJson.scripts

    for (const scriptName of ['build:desktop', 'build:release']) {
      expect(scripts[scriptName]).toContain('pnpm run build:mobile-web')
      for (const match of scripts[scriptName].matchAll(/pnpm run ([\w:-]+)/g)) {
        expect(scripts, `${scriptName} -> ${match[1]}`).toHaveProperty(match[1])
      }
    }
    expect(scripts['build:desktop']).toContain('pnpm run typecheck:mobile-web')
  })
})
