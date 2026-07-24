import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveBoundedSshConfigGlob } from './ssh-config-bounded-glob'

const pathApi = process.platform === 'win32' ? win32 : posix
const tempRoots: string[] = []
const SOURCE = readFileSync(new URL('./ssh-config-bounded-glob.ts', import.meta.url), 'utf8')

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-ssh-config-glob-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('bounded SSH config include globbing', () => {
  it('retains only the first 256 sorted matches without materializing every result', () => {
    const root = makeTempRoot()
    const includeDir = join(root, 'conf.d')
    mkdirSync(includeDir)
    for (let index = 0; index < 2_000; index += 1) {
      writeFileSync(join(includeDir, `${String(index).padStart(4, '0')}.conf`), '')
    }

    const result = resolveBoundedSshConfigGlob(join(includeDir, '*.conf'), pathApi, 256)

    expect(result.totalMatches).toBe(2_000)
    expect(result.truncated).toBe(true)
    expect(result.matches).toHaveLength(256)
    expect(result.matches.map((filePath) => basename(filePath))).toEqual(
      Array.from({ length: 256 }, (_, index) => `${String(index).padStart(4, '0')}.conf`)
    )
    expect(SOURCE).not.toContain('globSync')
  })

  it('scans past nonmatches and preserves sorted order below the cap', () => {
    const root = makeTempRoot()
    const includeDir = join(root, 'conf.d')
    mkdirSync(includeDir)
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(join(includeDir, `${index}.txt`), '')
    }
    writeFileSync(join(includeDir, 'zeta.conf'), '')
    writeFileSync(join(includeDir, 'alpha.conf'), '')

    const result = resolveBoundedSshConfigGlob(join(includeDir, '*.conf'), pathApi, 256)

    expect(result).toMatchObject({ totalMatches: 2, truncated: false })
    expect(result.matches.map((filePath) => basename(filePath))).toEqual([
      'alpha.conf',
      'zeta.conf'
    ])
  })

  it('rejects path patterns deep enough to threaten the traversal stack', () => {
    const pattern = pathApi.join(
      pathApi.parse(process.cwd()).root,
      ...Array.from({ length: 65 }, () => '*')
    )

    expect(resolveBoundedSshConfigGlob(pattern, pathApi, 256)).toEqual({
      matches: [],
      totalMatches: 0,
      truncated: true,
      patternTooDeep: true
    })
  })
})
