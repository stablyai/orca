import { readFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const READ_MODULES = [
  'src/main/scryer/engine/read-selector.ts',
  'src/main/scryer/engine/read-selector-model.ts',
  'src/main/scryer/engine/read-selector-model-navigation.ts',
  'src/main/scryer/engine/read-selector-model-overview.ts',
  'src/main/scryer/engine/read-selector-model-subtree.ts',
  'src/main/scryer/engine/read-selector-query.ts',
  'src/main/scryer/engine/read-selector-result.ts',
  'src/main/scryer/engine/read-selector-search.ts',
  'src/main/scryer/engine/operations/model-read.ts',
  'src/main/scryer/engine/operations/model-search.ts',
  'src/main/scryer/engine/operations/model-query.ts',
  'src/main/scryer/engine/operations/rules-read.ts',
  'src/main/scryer/engine/operations/codebase-read.ts'
]

const FORBIDDEN_IMPORTS = [
  'mcp-tools',
  'model-store',
  'legacy-c4',
  'renderer',
  'src/cli',
  '../../cli',
  '../../../cli',
  '../../../../cli'
]

async function readModule(path: string): Promise<string> {
  return readFile(join(ROOT, path), 'utf8')
}

describe('#31 read module ownership', () => {
  it('forbids read executors from importing legacy or adapter layers', async () => {
    for (const path of READ_MODULES) {
      const source = await readModule(path)
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(source, `${path} must not import ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('isolates filesystem and rules asset access to the approved sibling readers', async () => {
    for (const path of READ_MODULES) {
      const source = await readModule(path)
      const importsFilesystem = /from ['"]fs(?:\/promises)?['"]/.test(source)
      const importsRulesAsset = source.includes('shared/scryer/rules')

      expect(importsFilesystem, `${path} filesystem access`).toBe(path.endsWith('codebase-read.ts'))
      expect(importsRulesAsset, `${path} rules asset access`).toBe(path.endsWith('rules-read.ts'))
    }
  })
})
