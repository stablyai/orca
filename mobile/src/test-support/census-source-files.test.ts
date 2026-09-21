import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
    // The shape that started this: a generated file whose text holds exactly what a census is
    // looking for. Every one of them is minified vendor output, so the match is a token in
    // somebody else's code and the census has no line to offer anybody.
    const violating = "import { requiredString } from '../../src/shared/rpc-contract/params'\n"
    plant('src/components/engine.generated.ts', violating)
    plant('src/components/Diagram.tsx', violating)

    const walked = censusSourceFiles(join(scratch, 'src')).map((path) => relative(scratch, path))
    expect(walked).toEqual([join('src', 'components', 'Diagram.tsx')])
    // Both halves: the generated file is gone, and the file beside it carrying the same text is
    // not — a walk that returned nothing at all would satisfy the first line on its own.
    expect(readFileSync(join(scratch, 'src/components/engine.generated.ts'), 'utf8')).toBe(
      violating
    )
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
    // The list is `mobile/.gitignore`, because that is what the generators and the build agree on.
    // A sixth artifact landing under a name this predicate does not match would put a multi-megabyte
    // vendor bundle back into every census, which is the failure this module exists for.
    const ignored = readFileSync(join(mobileRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.generated.ts'))
    expect(ignored.length).toBeGreaterThanOrEqual(5)
    for (const entry of ignored) {
      expect(isGeneratedSource(entry), entry).toBe(true)
    }
  })

  it('is the only walk of its kind left in the tree', () => {
    // The line every census used to hold a copy of. One spelling, so a tenth census cannot quietly
    // reintroduce the cost by pasting the walk rather than importing it.
    const copies: string[] = []
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') {
            walk(path)
          }
          continue
        }
        if (!/\.tsx?$/.test(entry.name) || isGeneratedSource(entry.name)) {
          continue
        }
        if (readFileSync(path, 'utf8').includes("entry.name === 'node_modules' ? []")) {
          copies.push(relative(mobileRoot, path))
        }
      }
    }
    walk(join(mobileRoot, 'src'))
    walk(join(mobileRoot, 'app'))
    // This file is in the list because it carries the line as the text it greps for; the module
    // beside it is the walk itself. Named rather than filtered out, so a third entry is a failure
    // that reads as one.
    expect(copies.sort()).toEqual([
      'src/test-support/census-source-files.test.ts',
      'src/test-support/census-source-files.ts'
    ])
  })
})
