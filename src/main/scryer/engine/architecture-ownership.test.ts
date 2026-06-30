import { readdir, readFile } from 'fs/promises'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path)))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path)
    }
  }
  return files
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/import\s+(?:type\s+)?(?:[^'"]+from\s+)?['"]([^'"]+)['"]/g)].map(
    (match) => match[1]!
  )
}

describe('Scryer architecture ownership', () => {
  it('keeps operation files behind the engine seam and away from IO/adapters', async () => {
    const operationFiles = await filesUnder(join(ROOT, 'src/main/scryer/engine/operations'))
    const forbidden = [
      '../state-store',
      '../pipeline',
      '../catalog',
      '../adapters',
      '../../model-store',
      '../../mcp-tools',
      '../../../../shared/scryer/model-types'
    ]

    for (const file of operationFiles) {
      const imports = importsOf(await readFile(file, 'utf8'))
      expect(
        imports.filter((specifier) =>
          forbidden.some((blocked) => specifier === blocked || specifier.startsWith(`${blocked}/`))
        ),
        `${relative(ROOT, file)} imports a forbidden dependency`
      ).toEqual([])
    }
  })

  it('prevents product adapters from importing engine internals directly', async () => {
    const adapterFiles = [
      join(ROOT, 'src/main/ipc/architecture.ts'),
      join(ROOT, 'src/cli/handlers/scryer.ts')
    ]
    const forbidden = [
      '/scryer/engine/state-store',
      '/scryer/engine/pipeline',
      '/scryer/engine/catalog',
      '/scryer/engine/operations',
      '/scryer/engine/validators',
      '/scryer/engine/diff',
      '/scryer/engine/fold',
      '/scryer/engine/id-minter',
      '/scryer/engine/source-router',
      '/scryer/engine/error-mapper'
    ]

    for (const file of adapterFiles) {
      const imports = importsOf(await readFile(file, 'utf8'))
      expect(
        imports.filter((specifier) =>
          forbidden.some((blocked) => specifier.includes(blocked.replace(/^\//, '')))
        ),
        `${relative(ROOT, file)} imports an engine internal module`
      ).toEqual([])
    }
  })

  it('keeps state-store independent of operations and product adapters', async () => {
    const imports = importsOf(
      await readFile(join(ROOT, 'src/main/scryer/engine/state-store.ts'), 'utf8')
    )

    expect(
      imports.filter(
        (specifier) =>
          specifier.includes('/operations') ||
          specifier.includes('/adapters') ||
          specifier.includes('/renderer') ||
          specifier.includes('/cli/')
      )
    ).toEqual([])
  })
})
