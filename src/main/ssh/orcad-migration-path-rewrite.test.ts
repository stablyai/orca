import { describe, expect, it } from 'vitest'
import {
  serializeOrcadMigrationValue,
  type OrcadMigrationCatalogPayload
} from '../../shared/orcad-migration-manifest'
import { isRecord } from '../../shared/orcad-migration-manifest-fields'
import { ownedEditorFileId } from '../../shared/workspace-session-pane-ownership'
import {
  ORCAD_MIGRATION_PATH_FIELDS,
  ORCAD_MIGRATION_UNREWRITTEN_PATH_FIELDS,
  type OrcadMigrationPathFieldKind
} from './orcad-migration-path-fields'
import {
  IDENTITY_ORCAD_MIGRATION_PATH_REWRITER,
  parseFieldLocation,
  rewriteOrcadMigrationPayloadPaths,
  type OrcadMigrationPathRewriter
} from './orcad-migration-path-rewrite'

const WT = 'repo-1::/src/wt'
const SAMPLE: Record<OrcadMigrationPathFieldKind, string> = {
  absolute: '/src/a',
  'maybe-absolute': '/src/b',
  relative: 'rel/c',
  url: 'file:///src/d',
  'worktree-id': WT,
  'owner-key': `worktree:${WT}`,
  'pty-session-id': `${WT}@@pty-1`,
  'editor-file-id': ownedEditorFileId('/src/wt/f.ts', WT, 'env-1')
}

/** Moves `/src` to `/dst` and marks relative paths, so every rewritten field is visible. */
const MARKING: OrcadMigrationPathRewriter = {
  path: (value, form) => {
    if (form === 'relative') {
      return value.startsWith('rel/') ? `REL/${value.slice(4)}` : value
    }
    if (form === 'url') {
      return value.replace(/^file:\/\/\/src\//, 'file:///dst/')
    }
    return value.startsWith('/src/') || value === '/src' ? `/dst${value.slice(4)}` : value
  }
}

/** One payload holding a sample at every location the table names. */
function payloadWithEveryField(): OrcadMigrationCatalogPayload {
  const root: Record<string, unknown> = {
    repositories: [],
    projectGroups: [],
    folderWorkspaces: []
  }
  for (const field of ORCAD_MIGRATION_PATH_FIELDS) {
    place(root, parseFieldLocation(field.at), SAMPLE[field.kind])
  }
  // The stage is shape-agnostic, so a sparse object stands in for a full payload.
  return { repositories: [], projectGroups: [], folderWorkspaces: [], ...root }
}

function payloadWithManyOwnerKeys(count: number): OrcadMigrationCatalogPayload {
  const root: Record<string, unknown> = {}
  const steps = parseFieldLocation('dormantState.workspaceSession.tabsByWorktree{key}')
  for (let index = 0; index < count; index++) {
    place(root, steps, `repo::/src/w${index}`)
  }
  return { repositories: [], projectGroups: [], folderWorkspaces: [], ...root }
}

function place(
  node: Record<string, unknown>,
  steps: ReturnType<typeof parseFieldLocation>,
  sample: string
): void {
  const [step, next, ...rest] = steps
  if (step?.type !== 'prop') {
    throw new Error('table locations start with a property')
  }
  if (!next) {
    node[step.name] = sample
    return
  }
  node[step.name] = placeInto(node[step.name], [next, ...rest], sample)
}

function placeInto(
  existing: unknown,
  steps: ReturnType<typeof parseFieldLocation>,
  sample: string
): unknown {
  const [step, ...rest] = steps
  if (!step) {
    return sample
  }
  if (step.type === 'items') {
    const items = Array.isArray(existing) ? existing : []
    items[0] = placeInto(items[0], rest, sample)
    return items
  }
  const record = isRecord(existing) ? existing : {}
  if (step.type === 'keys') {
    record[sample] = true
  } else if (step.type === 'values') {
    record.entry = placeInto(record.entry, rest, sample)
  } else {
    record[step.name] = placeInto(record[step.name], rest, sample)
  }
  return record
}

function valuesAt(node: unknown, steps: ReturnType<typeof parseFieldLocation>): unknown[] {
  const [step, ...rest] = steps
  if (!step) {
    return [node]
  }
  if (step.type === 'items') {
    return Array.isArray(node) ? node.flatMap((item) => valuesAt(item, rest)) : []
  }
  if (!isRecord(node)) {
    return []
  }
  if (step.type === 'keys') {
    return Object.keys(node).filter((key) => key !== 'entry')
  }
  if (step.type === 'values') {
    return Object.values(node).flatMap((value) => valuesAt(value, rest))
  }
  return valuesAt(node[step.name], rest)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

describe('orcad migration path-rewrite stage', () => {
  it('is exact under the identity: same value, same bytes, same key order, input untouched', () => {
    const input = deepFreeze(payloadWithEveryField())
    const output = rewriteOrcadMigrationPayloadPaths(input, IDENTITY_ORCAD_MIGRATION_PATH_REWRITER)
    expect(output).not.toBe(input)
    expect(output).toEqual(input)
    expect(JSON.stringify(output)).toBe(JSON.stringify(input))
    expect(serializeOrcadMigrationValue(output)).toBe(serializeOrcadMigrationValue(input))
  })

  // Regression: renaming re-read Object.keys per entry, so a 20k-key record took seconds.
  it('walks a large keyed record in linear time', () => {
    const started = performance.now()
    rewriteOrcadMigrationPayloadPaths(payloadWithManyOwnerKeys(20_000), MARKING)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('reaches every field the table names', () => {
    const input = deepFreeze(payloadWithEveryField())
    const output = rewriteOrcadMigrationPayloadPaths(input, MARKING)
    for (const field of ORCAD_MIGRATION_PATH_FIELDS) {
      const values = valuesAt(output, parseFieldLocation(field.at))
      expect(values, field.at).not.toEqual([])
      for (const value of values) {
        expect(value, field.at).not.toBe(SAMPLE[field.kind])
        expect(String(value), field.at).not.toMatch(/\/src\/|%2Fsrc%2F|^rel\//)
      }
    }
  })

  it('names every location once, and never both rewrites and skips one', () => {
    const rewritten = ORCAD_MIGRATION_PATH_FIELDS.map((field) => field.at)
    expect(new Set(rewritten).size).toBe(rewritten.length)
    for (const skipped of ORCAD_MIGRATION_UNREWRITTEN_PATH_FIELDS) {
      expect(rewritten).not.toContain(skipped.at)
    }
  })

  it('rewrites only the path half of composite ids', () => {
    const map = (kind: OrcadMigrationPathFieldKind, value: string): unknown => {
      const field = ORCAD_MIGRATION_PATH_FIELDS.find((entry) => entry.kind === kind)!
      const payload = { repositories: [], projectGroups: [], folderWorkspaces: [] }
      place(payload, parseFieldLocation(field.at), value)
      return valuesAt(
        rewriteOrcadMigrationPayloadPaths(payload, MARKING),
        parseFieldLocation(field.at)
      )[0]
    }
    const instance = '::workspace:0b6c2c1e-8a39-4c55-9a52-0d7a7f2b1c11'
    expect(map('worktree-id', `${WT}${instance}`)).toBe(`repo-1::/dst/wt${instance}`)
    expect(map('worktree-id', 'repo-1')).toBe('repo-1')
    expect(map('owner-key', 'folder:/src/not-a-path')).toBe('folder:/src/not-a-path')
    expect(map('owner-key', WT)).toBe('repo-1::/dst/wt')
    expect(map('pty-session-id', `folder:f-1@@pty`)).toBe('folder:f-1@@pty')
    expect(map('pty-session-id', 'opaque-relay-id')).toBe('opaque-relay-id')
    expect(map('editor-file-id', SAMPLE['editor-file-id'])).toBe(
      ownedEditorFileId('/dst/wt/f.ts', 'repo-1::/dst/wt', 'env-1')
    )
    expect(map('editor-file-id', '/src/wt/raw.ts')).toBe('/dst/wt/raw.ts')
    expect(map('editor-file-id', 'tab-uuid')).toBe('tab-uuid')
  })

  it('refuses a rewrite that would merge two records', () => {
    const payload = payloadWithEveryField()
    const session = payload.dormantState?.workspaceSession
    expect(session).toBeDefined()
    session!.tabsByWorktree = { 'repo-1::/src/a': [], 'repo-1::/src/b': [] }
    const merging: OrcadMigrationPathRewriter = {
      path: (value) => (value.startsWith('/src') ? '/dst' : value)
    }
    expect(() => rewriteOrcadMigrationPayloadPaths(payload, merging)).toThrow(
      'orcad_migration_path_rewrite_key_collision'
    )
  })
})
