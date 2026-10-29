import type {
  SessionScalarField,
  SessionUnitReader,
  SessionPresence,
  SessionEntry
} from '../../../shared/session-unit-reader'
import { isDeepStrictEqual } from 'node:util'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import { SESSION_MAP_FIELDS } from '../../../shared/session-change-set'

import { rollbackSessionUnit } from '../restoring-sessions/workspace-session-write-rollback'

/** The inverse reads only the slots owned by the failed publication. */
export function reducePtyBindingRollback(
  reader: SessionUnitReader,
  staged: SessionUnitReader,
  binding?: { owner: string; tabId: string; leafId: string }
): void {
  let originalTabs = binding && staged.unit('tabsByWorktree', binding.owner, 'prior')
  let originalLayout = binding && staged.unit('terminalLayoutsByTabId', binding.tabId, 'prior')
  if (binding) {
    const { owner, tabId, leafId } = binding
    const tabOf = (source: SessionUnitReader, phase: 'prior' | 'candidate' = 'candidate') =>
      source.unit('tabsByWorktree', owner, phase).value?.find((row) => row.id === tabId)
    const stateOf = (source: SessionUnitReader) => {
      const tab = tabOf(source)
      return {
        createdAt: tab?.createdAt,
        generation: tab?.generation,
        worktreeId: tab?.worktreeId,
        ptyId: isTerminalLeafId(leafId)
          ? source.unit('terminalLayoutsByTabId', tabId).value?.ptyIdsByLeafId?.[leafId]
          : tab?.ptyId,
        incarnation: source.unit('terminalPtyIncarnationsByPaneKey', `${tabId}:${leafId}`).value
      }
    }
    if (!isDeepStrictEqual(stateOf(reader), stateOf(staged))) {
      return
    }
    const stagedTab = tabOf(staged)
    const stagedLayout = staged.unit('terminalLayoutsByTabId', tabId).value
    if (
      stagedTab &&
      (!isDeepStrictEqual(tabOf(reader), stagedTab) ||
        !isDeepStrictEqual(reader.unit('terminalLayoutsByTabId', tabId).value, stagedLayout))
    ) {
      if (!tabOf(staged, 'prior')) {
        originalTabs = {
          present: true,
          value: [...(originalTabs?.value ?? []), { ...stagedTab, ptyId: null }]
        }
      }
      if (!originalLayout?.value && stagedLayout) {
        originalLayout = { present: true, value: { ...stagedLayout, ptyIdsByLeafId: {} } }
      }
    }
  }
  for (const field of SESSION_MAP_FIELDS) {
    for (const key of staged.changedKeys(field)) {
      let before: SessionPresence<SessionEntry<typeof field>> = staged.unit(field, key, 'prior')
      if (binding && field === 'tabsByWorktree' && key === binding.owner && originalTabs) {
        before = originalTabs
      }
      if (
        binding &&
        field === 'terminalLayoutsByTabId' &&
        key === binding.tabId &&
        originalLayout
      ) {
        before = originalLayout
      }
      reader.write(
        field,
        key,
        rollbackSessionUnit(before, staged.unit(field, key), reader.unit(field, key))
      )
    }
    if (reader.touches(field) && reader.entryCount(field) === 0) {
      reader.reconcileField(field, {
        kind: 'rollback',
        present: Object.hasOwn(staged.prior, field),
        ...(Object.hasOwn(staged.prior, field) && staged.prior[field] === undefined
          ? { valueWhenEmpty: 'undefined' }
          : {})
      })
    }
  }
  for (const field of staged.touchedFields()) {
    if (SESSION_MAP_FIELDS.some((name) => name === field)) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: declared map fields are excluded above.
    const key = field as SessionScalarField
    reader.replace(
      key,
      rollbackSessionUnit(staged.field(key, 'prior'), staged.field(key), reader.field(key))
    )
  }

  if (binding) {
    const { tabId } = binding
    const restored = reader.unit('terminalLayoutsByTabId', tabId).value
    const current = reader.unit('terminalLayoutsByTabId', tabId, 'prior').value
    const written = staged.unit('terminalLayoutsByTabId', tabId).value
    if (restored && current && !isDeepStrictEqual(current.root, written?.root)) {
      reader.write('terminalLayoutsByTabId', tabId, {
        present: true,
        value: { ...restored, root: current.root }
      })
    }
  }
}
