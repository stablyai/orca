import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { censusSourceFiles, isGeneratedSource } from './census-source-files'

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url))

let scratch = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-census-source-files-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function plant(relativePath: string, source: string): void {
  const absolute = join(scratch, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, source, 'utf8')
}

describe('the source files a census reads', () => {
  it('leaves out build output that would be read as a violating import', () => {
    // Generated vendor text can match source rules without any editable repository call site.
    const violating = "import { requiredString } from '../../src/shared/rpc-contract/params'\n"
    plant('src/components/engine.generated.ts', violating)
    plant('src/components/Diagram.tsx', violating)

    const walked = censusSourceFiles(join(scratch, 'src')).map((path) => relative(scratch, path))
    expect(walked).toEqual([join('src', 'components', 'Diagram.tsx')])
  })

  it('leaves out node_modules, and keeps everything else', () => {
    plant('src/a.ts', '')
    plant('src/node_modules/dep/index.ts', '')
    plant('src/deep/b.tsx', '')
    plant('src/notes.md', '')
    expect(
      censusSourceFiles(join(scratch, 'src'))
        .map((path) => relative(scratch, path))
        .sort()
    ).toEqual([join('src', 'a.ts'), join('src', 'deep', 'b.tsx'), join('src', 'notes.md')].sort())
  })

  it('names build output by the suffix the generators write, and nothing else', () => {
    expect(isGeneratedSource('mermaid-page-engine.generated.ts')).toBe(true)
    expect(isGeneratedSource('route-manifest.generated.tsx')).toBe(true)
    expect(isGeneratedSource('generated.ts')).toBe(false)
    expect(isGeneratedSource('rpc-client.ts')).toBe(false)
    expect(isGeneratedSource('generated-goldens.ts')).toBe(false)
  })

  it('covers every artifact the tree generates, read from the ignore file that lists them', () => {
    // Use gitignore as the generated-artifact authority; new names must not silently reintroduce megabytes into source censuses.
    const ignored = readFileSync(join(mobileRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.generated.ts'))
    expect(ignored.length).toBeGreaterThan(0)
    for (const entry of ignored) {
      expect(isGeneratedSource(entry), entry).toBe(true)
    }
  })
})
