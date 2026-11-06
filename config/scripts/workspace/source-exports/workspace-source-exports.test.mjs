import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWorkspaceSourceResolver } from './workspace-source-exports.mjs'

const temporary = []
afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture({ exports = {}, patterns = ['src/packages/*'], extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-source-exports-'))
  temporary.push(root)
  const files = {
    'pnpm-workspace.yaml': `packages:\n${patterns.map((pattern) => `  - '${pattern}'`).join('\n')}\n`,
    'src/packages/process-host/package.json': JSON.stringify({
      name: '@orca/process-host',
      exports
    }),
    'src/packages/process-host/src/run-process.ts': 'export const value = 1',
    'src/packages/process-host/src/process-spec.ts': 'export type Value = number',
    'src/packages/process-host/dist/run-process.js': 'throw Error("stale build must not execute")',
    ...extra
  }
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }
  return root
}

const publicExports = {
  '.': {
    'orca-source': './src/run-process.ts',
    types: './dist/run-process.d.ts',
    default: './dist/run-process.js'
  },
  './process-spec': {
    'orca-source': './src/process-spec.ts',
    types: './dist/process-spec.d.ts',
    default: './dist/process-spec.js'
  }
}

it('maps only explicit public source exports with exact aliases independent of compiled output', () => {
  const resolver = createWorkspaceSourceResolver(fixture({ exports: publicExports }))
  expect(resolver.resolve('@orca/process-host')).toMatchObject({
    file: 'src/packages/process-host/src/run-process.ts',
    manifest: 'src/packages/process-host/package.json'
  })
  expect(resolver.resolve('@orca/process-host/process-spec').file).toBe(
    'src/packages/process-host/src/process-spec.ts'
  )
  expect(resolver.aliases.map((alias) => alias.find.test('@orca/process-host'))).toEqual([
    true,
    false
  ])
  expect(resolver.aliases.map((alias) => alias.find.test('@orca/process-host/private'))).toEqual([
    false,
    false
  ])
  expect(resolver.aliases.every((alias) => !alias.replacement.includes('/dist/'))).toBe(true)
  expect(resolver.esbuildAliases).toEqual({
    '@orca/process-host': resolver.resolve('@orca/process-host').path,
    '@orca/process-host/process-spec': resolver.resolve('@orca/process-host/process-spec').path
  })
  expect(resolver.resolve('node:child_process')).toBeNull()
  expect(resolver.resolve('zod')).toBeNull()
})

it('respects excluded workspace packages and independent workspaces', () => {
  const root = fixture({
    exports: publicExports,
    patterns: ['src/packages/*', '!src/packages/process-host'],
    extra: {
      'mobile/packages/model/package.json': JSON.stringify({
        name: '@orca/mobile-model',
        exports: publicExports
      })
    }
  })
  const resolver = createWorkspaceSourceResolver(root)
  expect(resolver.aliases).toEqual([])
  expect(() => resolver.resolve('@orca/process-host')).toThrow('No public orca-source export')
  expect(() => resolver.resolve('@orca/mobile-model')).toThrow('No public orca-source export')
})
