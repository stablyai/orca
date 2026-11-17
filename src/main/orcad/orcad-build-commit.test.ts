import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOrcadBuildCommit } from './orcad-build-commit'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const roots: string[] = []

function installRoot(files: { sourceCommit?: string; pkg?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-commit-'))
  roots.push(root)
  if (files.sourceCommit !== undefined) {
    writeFileSync(join(root, 'SOURCE_COMMIT'), files.sourceCommit)
  }
  if (files.pkg !== undefined) {
    mkdirSync(join(root, 'out'))
    writeFileSync(join(root, 'out', 'package.json'), files.pkg)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('readOrcadBuildCommit', () => {
  it('prefers the golden build SOURCE_COMMIT over the package stamp', async () => {
    const root = installRoot({ sourceCommit: `${A}\n`, pkg: JSON.stringify({ commit: B }) })
    await expect(readOrcadBuildCommit(root)).resolves.toBe(A)
  })

  it('falls back to the package commit stamp', async () => {
    const root = installRoot({ pkg: JSON.stringify({ commit: B }) })
    await expect(readOrcadBuildCommit(root)).resolves.toBe(B)
  })

  it('ignores malformed stamps', async () => {
    const malformed = installRoot({ sourceCommit: 'main', pkg: '{"commit":"abc"}' })
    await expect(readOrcadBuildCommit(malformed)).resolves.toBeNull()
    await expect(readOrcadBuildCommit(installRoot({ pkg: 'not json' }))).resolves.toBeNull()
    await expect(readOrcadBuildCommit(installRoot({}))).resolves.toBeNull()
  })
})
