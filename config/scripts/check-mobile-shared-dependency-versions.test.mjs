import { readFileSync } from 'node:fs'
import { lockfileRootImporter } from './pnpm-lockfile-root-importer.mjs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findSharedDependencyVersionProblems,
  main
} from './check-mobile-shared-dependency-versions.mjs'

const projectDir = path.resolve(import.meta.dirname, '../..')
const locked = (version) => ({ dependencies: { zod: { specifier: '~4.6.0', version } } })
const checkZod = (rootImporter, mobileImporter) =>
  findSharedDependencyVersionProblems({ rootImporter, mobileImporter, names: ['zod'] })

describe('findSharedDependencyVersionProblems', () => {
  it('passes when both lockfiles resolve the same version', () => {
    expect(checkZod(locked('4.6.7'), locked('4.6.7'))).toEqual([])
  })

  it('reports two resolved versions', () => {
    expect(checkZod(locked('4.6.7'), locked('4.6.5'))).toEqual([
      'zod: the root locks 4.6.7, mobile locks 4.6.5'
    ])
  })

  it('ignores peer and patch suffixes and reads devDependencies', () => {
    expect(
      checkZod(
        { devDependencies: { zod: { version: '4.6.7(typescript@6.0.3)' } } },
        locked('4.6.7(patch_hash=abc)')
      )
    ).toEqual([])
  })

  it('reports a side that stopped declaring the dependency', () => {
    expect(checkZod(locked('4.6.7'), {})).toEqual(['zod is not a direct dependency of mobile'])
    expect(checkZod({}, locked('4.6.7'))).toEqual(['zod is not a direct dependency of the root'])
  })

  it('checks every shared and toolchain dependency by default', () => {
    const problems = findSharedDependencyVersionProblems({
      rootImporter: locked('4.6.7'),
      mobileImporter: locked('4.6.7')
    })
    expect(problems).toEqual([
      'smol-toml is not a direct dependency of the root',
      'tweetnacl is not a direct dependency of the root',
      '@noble/hashes is not a direct dependency of the root',
      '@types/ws is not a direct dependency of the root',
      'typescript is not a direct dependency of the root',
      'typescript-api is not a direct dependency of the root',
      'vitest is not a direct dependency of the root'
    ])
  })
})

describe('committed lockfiles', () => {
  it('rejects a mobile release lock missing the actual shared parser dependency', () => {
    const read = (file) => lockfileRootImporter(readFileSync(path.join(projectDir, file), 'utf8'))
    const rootImporter = read('pnpm-lock.yaml')
    const mobileImporter = read('mobile/pnpm-lock.yaml')
    delete mobileImporter.dependencies['smol-toml']
    expect(findSharedDependencyVersionProblems({ rootImporter, mobileImporter })).toEqual([
      'smol-toml is not a direct dependency of mobile'
    ])
  })

  it('pass the repository check', () => {
    expect(main(projectDir)).toBe(0)
  })
})
