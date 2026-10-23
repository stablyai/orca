import { existsSync, mkdtempSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal'
import { collectTypecheckPass, findTsNocheckFiles } from './check-tests-typecheck-ratchet.mjs'

it.each([
  { compiler: 'javascript', incremental: true },
  { compiler: 'native', incremental: false }
])(
  'rechecks changed types, diagnostics and test membership with $compiler',
  ({ compiler, incremental }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-mobile-typecheck-')))
    const cache = join(root, '.cache')
    vi.stubEnv('ORCA_MOBILE_TYPECHECK_CACHE_DIR', cache)
    vi.stubEnv('ORCA_MOBILE_TYPECHECK_COMPILER', compiler)
    try {
      writeFileSync(
        join(root, 'tsconfig.test.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            skipLibCheck: true,
            types: [],
            target: 'ES2022',
            incremental: true
          },
          include: ['*.ts']
        })
      )
      writeFileSync(join(root, 'model.ts'), 'export interface Shape { value: number }')
      const test = join(root, 'value.test.ts')
      const source = "import type { Shape } from './model'; const shape: Shape = { value: 1 }"
      writeFileSync(test, source)
      const clean = collectTypecheckPass(root)
      expect(clean).toEqual({ failing: [], programTestFiles: ['value.test.ts'] })
      expect(existsSync(join(cache, 'tests.tsbuildinfo'))).toBe(incremental)
      expect(existsSync(join(root, 'tsconfig.test.tsbuildinfo'))).toBe(false)
      expect(collectTypecheckPass(root)).toEqual(clean)

      writeFileSync(join(root, 'model.ts'), 'export interface Shape { value: string }')
      const failed = collectTypecheckPass(root)
      expect(failed.failing).toEqual(['value.test.ts'])
      expect(collectTypecheckPass(root)).toEqual(failed)

      writeFileSync(join(root, 'new.test.ts'), 'export const value: number = 1')
      expect(collectTypecheckPass(root).programTestFiles).toEqual(['new.test.ts', 'value.test.ts'])
      writeFileSync(test, `// @ts-nocheck\n${source}`)
      const nocheck = collectTypecheckPass(root)
      expect(nocheck.failing).toEqual([])
      expect(findTsNocheckFiles(root, nocheck.programTestFiles)).toEqual(['value.test.ts'])

      unlinkSync(test)
      expect(collectTypecheckPass(root)).toEqual({ failing: [], programTestFiles: ['new.test.ts'] })
    } finally {
      vi.unstubAllEnvs()
      removeTreeSync(root)
    }
  },
  15_000
)
