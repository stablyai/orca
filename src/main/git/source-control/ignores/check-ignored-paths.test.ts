import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkIgnoredPaths } from './check-ignored-paths'

describe('checkIgnoredPaths with real git', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  // Why: macOS Git composes a decomposed (NFD) name only when it reads it from disk or argv, not
  // from stdin, and it leaves a CJK compatibility ideograph as it is while NFC rewrites it.
  it.skipIf(process.platform !== 'darwin')(
    'reports a decomposed name and a CJK compatibility ideograph that .gitignore lists',
    async () => {
      const repoPath = mkdtempSync(join(tmpdir(), 'orca-check-ignored-'))
      tempPaths.push(repoPath)
      execFileSync('git', ['init', '--quiet', repoPath])
      const decomposed = '캐시.txt'.normalize('NFD')
      const compatibility = '\uF900.txt'
      writeFileSync(join(repoPath, '.gitignore'), `캐시.txt\n${compatibility}\n`)
      for (const name of [decomposed, compatibility, 'kept.txt']) {
        writeFileSync(join(repoPath, name), '')
      }

      const ignored = await checkIgnoredPaths(repoPath, [decomposed, compatibility, 'kept.txt'])

      expect(ignored.sort()).toEqual([decomposed, compatibility].sort())
    }
  )
})
