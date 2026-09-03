import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type PnpmWorkspace = {
  patchedDependencies?: Record<string, string>
}

function readJson(relativePath: string): PackageJson {
  return JSON.parse(readFileSync(join(projectDir, relativePath), 'utf8')) as PackageJson
}

function readWorkspace(relativePath: string): PnpmWorkspace {
  return parse(readFileSync(join(projectDir, relativePath), 'utf8')) as PnpmWorkspace
}

function declaredSpecifier(pkg: PackageJson, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.optionalDependencies?.[name]
}

function patchKeyVersion(
  patchedDependencies: Record<string, string> | undefined,
  name: string
): string {
  const prefix = `${name}@`
  const keys = Object.keys(patchedDependencies ?? {}).filter((key) => key.startsWith(prefix))
  expect(keys, `${name} patchedDependencies key`).toHaveLength(1)
  const version = keys[0]?.slice(prefix.length) ?? ''
  expect(version.length, `${name} patch version`).toBeGreaterThan(0)
  return version
}

function expectExactPin(packageJsonPath: string, workspacePath: string, name: string): void {
  const version = patchKeyVersion(readWorkspace(workspacePath).patchedDependencies, name)
  const specifier = declaredSpecifier(readJson(packageJsonPath), name)
  expect(specifier, `${name} must be exact ${version}, not ^/~/=`).toBe(version)
}

describe('patched dependency specifiers', () => {
  it('exact-pins node-pty to the root patchedDependencies key', () => {
    expectExactPin('package.json', 'pnpm-workspace.yaml', 'node-pty')
  })

  it('exact-pins react-native to the mobile patchedDependencies key', () => {
    expectExactPin(
      join('mobile', 'package.json'),
      join('mobile', 'pnpm-workspace.yaml'),
      'react-native'
    )
  })
})
