import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree, type ScannedFile } from '../../../shared/source-scan/source-tree-scan'
import { AGENT_GROUP_NAMES } from './groups'

// Why this ratchet: the resolver derives its agent-name groups from the canonical agent list,
// but the guides a coordinator actually reads were hand-kept and fell twenty-eight names behind
// it — `@antigravity` resolved fine while every shipped description called the set a closed
// nine. A paragraph naming two agent groups is enumerating the set and will drift again; one
// name is an example. Write the generic form instead: `@all`, `@idle`, `@worktree:<id>`,
// `@<agent>`. src/cli/bundled-skill-guides.ts is covered transitively — it is generated from
// skill-guides/ and `verify:bundled-skill-guides` keeps it in step.

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..')
const DOC_ROOTS = ['skill-guides', 'docs']
const DOC_EXTENSIONS = /\.mdx?$/u
const MAX_AGENT_GROUPS_PER_PARAGRAPH = 1

const agentGroupNames = new Set(AGENT_GROUP_NAMES)

/**
 * Why the shared ratchet walk: `docs/site` is a self-contained Next.js app, and its own README
 * tells contributors to `pnpm --ignore-workspace install` there, so `docs/site/node_modules`
 * (plus `.next`, `.source`, `out`) sits on disk for anyone who has previewed the docs. A plain
 * recursive walk read dependency markdown and failed this test on a file the contributor
 * neither owns nor can edit. `scanSourceTree` skips those trees and dot-directories.
 */
function docFiles(root: string): ScannedFile[] {
  return scanSourceTree(join(repoRoot, root), {
    extensions: DOC_EXTENSIONS,
    // `isTestFile` matches any path containing `repro`, which is prose in a doc, not a fixture.
    includeTests: true
  })
}

/** Only backticked `@name` counts, so npm scopes like `@opencode-ai/sdk` are not group addresses. */
function agentGroupsNamed(paragraph: string): string[] {
  const named = new Set<string>()
  for (const match of paragraph.matchAll(/`@([a-z0-9-]+)`/gu)) {
    if (agentGroupNames.has(match[1])) {
      named.add(match[1])
    }
  }
  return [...named].sort()
}

function enumerationsIn(file: ScannedFile): string[] {
  const contents = file.source.replace(/\r\n/gu, '\n')
  let line = 1
  return contents.split(/\n[ \t]*\n/u).flatMap((paragraph) => {
    const lines = paragraph.split('\n')
    const start = line
    line += lines.length + 1
    const named = agentGroupsNamed(paragraph)
    if (named.length <= MAX_AGENT_GROUPS_PER_PARAGRAPH) {
      return []
    }
    const offset = lines.findIndex((text) => agentGroupsNamed(text).length > 0)
    return [`${relative(repoRoot, file.path)}:${start + offset} names ${named.join(', ')}`]
  })
}

describe('group address documentation', () => {
  it('never enumerates the agent-name groups, which drift behind the resolver', () => {
    const enumerations = DOC_ROOTS.flatMap((root) => docFiles(root).flatMap(enumerationsIn))

    // The remedy belongs in the failure itself; a bare array diff does not suggest one.
    expect(
      enumerations,
      'Name at most one agent group per paragraph and write the set generically: `@all`, `@idle`, `@worktree:<id>`, `@<agent>`.'
    ).toEqual([])
  })

  it('reads only the repository docs, not an installed dependency tree under docs/site', () => {
    const scanned = DOC_ROOTS.flatMap((root) => docFiles(root).map((file) => file.path))

    expect(scanned.length).toBeGreaterThan(0)
    expect(
      scanned.filter((path) => /[\\/](?:node_modules|out|\.next|\.source)[\\/]/u.test(path))
    ).toEqual([])
  })

  it('derives the addressable agent groups from the canonical agent list', () => {
    expect(agentGroupNames.has('antigravity')).toBe(true)
    expect(agentGroupNames.size).toBeGreaterThan(9)
  })
})
