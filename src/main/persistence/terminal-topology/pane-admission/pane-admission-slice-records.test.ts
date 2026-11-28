// A per-workspace, per-tab or per-pane record left out of the slice's own records would keep a stale stored copy the old whole rewrite replaced.

import { expect, it } from 'vitest'
import { SESSION_FIELD_OWNERS } from '../../../../shared/workspace-layout/persistence/workspace-layout-beside'
import { SLICE_FIELD_SCOPES } from './pane-admission-slice-records'

it('places every stored field, and every keyed record field is slice-owned or partition-wide with a reason', () => {
  expect(Object.keys(SLICE_FIELD_SCOPES).sort()).toEqual(Object.keys(SESSION_FIELD_OWNERS).sort())
  for (const [field, scope] of Object.entries(SLICE_FIELD_SCOPES)) {
    if (typeof scope !== 'string') {
      expect(scope.partition.length, field).toBeGreaterThan(0)
      continue
    }
    if (/By(Worktree|WorktreeId|Workspace)$/.test(field)) {
      expect(['workspace', 'workspace-selection'], field).toContain(scope)
    } else if (field.endsWith('ByTabId')) {
      expect(['row', 'closed-tab'], field).toContain(scope)
    } else if (field.endsWith('ByPaneKey')) {
      expect(scope, field).toBe('pane')
    }
  }
})
