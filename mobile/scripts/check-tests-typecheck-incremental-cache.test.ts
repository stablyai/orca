import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { supportsTsrs } from '../../config/scripts/tsrs-typecheck-compiler.mjs'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal'
import { collectTypecheckPass, findTsNocheckFiles } from './check-tests-typecheck-ratchet.mjs'
import { resolveMobileTypecheckCommand } from './mobile-typecheck-compiler.mjs'

const mobileRoot = realpathSync(join(import.meta.dirname, '..'))

it.each([
  ...(supportsTsrs() ? [{ compiler: 'tsrs', incremental: true }] : []),
  { compiler: 'bun', incremental: false },
  { compiler: 'native', incremental: false }
])(
  'rechecks changed types, diagnostics and test membership with $compiler',
  ({ compiler, incremental }) => {
    // Inside mobile so the project resolves mobile's TypeScript, as the real test project does.
    const scratch = join(mobileRoot, 'node_modules', '.cache')
    mkdirSync(scratch, { recursive: true })
    const root = mkdtempSync(join(scratch, 'orca-mobile-typecheck-'))
    vi.stubEnv('ORCA_MOBILE_TYPECHECK_COMPILER', compiler)
    const buildInfo = resolveMobileTypecheckCommand('tsconfig.test.json', root).args.find((arg) =>
      arg.endsWith('.tsbuildinfo')
    )
    expect(Boolean(buildInfo)).toBe(incremental)
    try {
      writeFileSync(
        join(root, 'tsconfig.test.json'),
        JSON.stringify({
          compilerOptions: { strict: true, skipLibCheck: true, types: [], target: 'ES2022' },
          include: ['*.ts']
        })
      )
      writeFileSync(join(root, 'model.ts'), 'export interface Shape { value: number }')
      const test = join(root, 'value.test.ts')
      const source = "import type { Shape } from './model'; const shape: Shape = { value: 1 }"
      writeFileSync(test, source)
      const clean = collectTypecheckPass(root)
      expect(clean).toEqual({ failing: [], programTestFiles: ['value.test.ts'] })
      if (buildInfo) {
        expect(existsSync(buildInfo)).toBe(true)
      }
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
      if (buildInfo) {
        removeTreeSync(buildInfo)
      }
    }
  },
  30_000
)
