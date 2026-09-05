import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTypeScriptDefinition } from './typescript-language-service'

function positionOfOffset(content: string, offset: number): { lineNumber: number; column: number } {
  const before = content.slice(0, offset)
  const lines = before.split('\n')
  return { lineNumber: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

function positionInsideSecondOccurrence(
  content: string,
  needle: string
): { lineNumber: number; column: number } {
  const first = content.indexOf(needle)
  const second = content.indexOf(needle, first + 1)
  return positionOfOffset(content, second + 1)
}

describe('getTypeScriptDefinition', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createProject(): Promise<{ rootPath: string; srcPath: string }> {
    const rootPath = await mkdtemp(join(tmpdir(), 'orca-ts-definition-'))
    roots.push(rootPath)
    const srcPath = join(rootPath, 'src')
    await mkdir(srcPath, { recursive: true })
    await writeFile(
      join(rootPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2020', module: 'commonjs', moduleResolution: 'node' },
        include: ['src/**/*.ts']
      })
    )
    return { rootPath, srcPath }
  }

  it('resolves a definition that lives in another file', async () => {
    const { rootPath, srcPath } = await createProject()
    const utilFilePath = join(srcPath, 'util.ts')
    await writeFile(
      utilFilePath,
      'export function greet(name: string): string {\n  return name\n}\n'
    )
    const indexFilePath = join(srcPath, 'index.ts')
    const indexContent = "import { greet } from './util'\n\nconst message = greet('world')\n"

    const result = getTypeScriptDefinition({
      rootPath,
      filePath: indexFilePath,
      content: indexContent,
      position: positionInsideSecondOccurrence(indexContent, 'greet')
    })

    expect(result).not.toBeNull()
    expect(result?.filePath).toBe(utilFilePath)
    expect(result?.range.startLineNumber).toBe(1)
  })

  it('resolves a definition that lives in the same file', async () => {
    const { rootPath, srcPath } = await createProject()
    const filePath = join(srcPath, 'index.ts')
    const content = 'const total = 1\n\nconst doubled = total * 2\n'

    const result = getTypeScriptDefinition({
      rootPath,
      filePath,
      content,
      position: positionInsideSecondOccurrence(content, 'total')
    })

    expect(result).not.toBeNull()
    expect(result?.filePath).toBe(filePath)
    expect(result?.range.startLineNumber).toBe(1)
  })

  it('picks up definition changes made on disk to a file that is not the open editor', async () => {
    const { rootPath, srcPath } = await createProject()
    const utilFilePath = join(srcPath, 'util.ts')
    await writeFile(
      utilFilePath,
      'export function greet(name: string): string {\n  return name\n}\n'
    )
    const indexFilePath = join(srcPath, 'index.ts')
    const indexContent = "import { greet } from './util'\n\nconst message = greet('world')\n"
    const position = positionInsideSecondOccurrence(indexContent, 'greet')

    const first = getTypeScriptDefinition({
      rootPath,
      filePath: indexFilePath,
      content: indexContent,
      position
    })
    expect(first?.range.startLineNumber).toBe(1)

    // Shift `greet`'s declaration down a line, simulating an edit made outside this editor
    // (e.g. in another tab). util.ts was never opened here, so it has no override version.
    await writeFile(
      utilFilePath,
      '\nexport function greet(name: string): string {\n  return name\n}\n'
    )

    const second = getTypeScriptDefinition({
      rootPath,
      filePath: indexFilePath,
      content: indexContent,
      position
    })

    expect(second?.filePath).toBe(utilFilePath)
    expect(second?.range.startLineNumber).toBe(2)
  })

  it('returns null when the file is outside any tsconfig project', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'orca-ts-definition-'))
    roots.push(rootPath)
    const filePath = join(rootPath, 'orphan.ts')
    await writeFile(filePath, 'const value = 1\n')

    const result = getTypeScriptDefinition({
      rootPath,
      filePath,
      content: 'const value = 1\n',
      position: { lineNumber: 1, column: 7 }
    })

    expect(result).toBeNull()
  })
})
