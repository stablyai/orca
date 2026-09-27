import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('keeps the cookie fixture registry outside the persistence barrel graph', () => {
  const source = readFileSync(join(__dirname, 'browser-session-registry.ts'), 'utf8')

  expect(source).toMatch(
    /import\s*\{\s*getCanonicalUserDataPath\s*\}\s*from\s*['"]\.\.\/persistence\/loading-store\/user-data-path['"]/
  )
  expect(source).not.toMatch(/from\s*['"]\.\.\/persistence['"]/)
})
