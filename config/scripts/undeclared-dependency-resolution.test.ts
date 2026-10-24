import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { markdownParserAliases } from '../build-plugins/markdown-parser-exports'

const repoRoot = join(import.meta.dirname, '../..')
const repoNodeModules = join(repoRoot, 'node_modules')

const dependencyMap = z.record(z.string(), z.string()).optional()
const workspace = z
  .object({
    packageExtensions: z
      .record(
        z.string(),
        z.object({ dependencies: dependencyMap, peerDependencies: dependencyMap })
      )
      .optional(),
    addMissingPeerTypes: z.boolean().optional()
  })
  .parse(parse(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')))

// Every dependency pnpm-workspace.yaml adds, so a new entry is covered without editing this file.
const extensionPairs = Object.entries(workspace.packageExtensions ?? {}).flatMap(
  ([owner, extension]) =>
    [
      ...Object.keys(extension.dependencies ?? {}),
      ...Object.keys(extension.peerDependencies ?? {})
    ].map((dependency) => [owner, dependency] as const)
)

// These peer on react and ship .d.ts that import it; addMissingPeerTypes supplies @types/react.
const peerTypePairs = [
  '@dnd-kit/core',
  '@dnd-kit/sortable',
  '@dnd-kit/utilities',
  '@monaco-editor/react',
  'cmdk',
  'emoji-picker-react',
  'lucide-react',
  'react-colorful',
  'react-i18next',
  'sonner'
].map((owner) => [owner, '@types/react'] as const)

// Node's own lookup from the package's real location, without tripping over "exports" maps.
function isVisibleFrom(owner: string, dependency: string): boolean {
  const ownerDir = realpathSync(join(repoNodeModules, owner))
  const lookupDirs = createRequire(join(ownerDir, 'package.json')).resolve.paths(dependency) ?? []
  return lookupDirs.some((dir) => existsSync(join(dir, dependency, 'package.json')))
}

describe('undeclared dependency resolution', () => {
  it('covers every packageExtensions entry', () => {
    const owners = new Set(extensionPairs.map(([owner]) => owner))
    expect([...owners].sort()).toEqual(Object.keys(workspace.packageExtensions ?? {}).sort())
    expect(workspace.addMissingPeerTypes).toBe(true)
  })

  // Why: the global virtual store links only declared deps; pnpm-workspace.yaml supplies these.
  it.each([...extensionPairs, ...peerTypePairs])(
    '%s sees %s from its own install location',
    (owner, dependency) => {
      expect(isVisibleFrom(owner, dependency)).toBe(true)
    }
  )

  it('aliases the DOM-free decode-named-character-reference entry', () => {
    expect(markdownParserAliases['decode-named-character-reference']).toMatch(/[\\/]index\.js$/)
  })
})
