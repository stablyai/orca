import { describe, expect, it } from 'vitest'
import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration/orcad-migration-manifest'

import { isRecord } from '../../shared/orcad-migration/orcad-migration-manifest-fields'
import { ownedEditorFileId } from '../../shared/workspace-session/workspace-session-pane-ownership'
import {
  ORCAD_MIGRATION_PATH_FIELDS,
  type OrcadMigrationPathFieldKind
} from './orcad-migration-path-fields'

import {
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

/** Mark rewritten relative paths and map /src to /dst so omissions remain visible. */

function payloadWithEveryField(): OrcadMigrationCatalogPayload {
  const root: Record<string, unknown> = {
    repositories: [],
    projectGroups: [],
    folderWorkspaces: []
  }
  for (const field of ORCAD_MIGRATION_PATH_FIELDS) {
    place(root, parseFieldLocation(field.at), SAMPLE[field.kind])
  }
  // Sparse fixtures suffice because traversal follows the field table, not a full payload schema.
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

describe('orcad migration path-rewrite stage', () => {
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
