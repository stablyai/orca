import { describe, expect, it } from 'vitest'

import {
  countWorkspaceRecordReads,
  isScannedFile,
  SELECTOR_FILES
} from './check-workspace-record-read-ratchet.mjs'

describe('countWorkspaceRecordReads', () => {
  it('counts direct reads of the record fields', () => {
    const text = [
      'const rows = state.worktreesByRepo[repoId]',
      'useAppStore((s) => s.folderWorkspaces)',
      'const detected = get().detectedWorktreesByRepo',
      'const maybe = input?.worktreesByRepo ?? {}'
    ].join('\n')
    expect(countWorkspaceRecordReads(text)).toBe(4)
  })

  it('ignores the preload API, spreads, comments, strings and selector calls', () => {
    const text = [
      'await window.api.folderWorkspaces.update(args)',
      'const next = { ...worktreesByRepo, [repoId]: rows }',
      '// state.worktreesByRepo used to be read here',
      "t('sidebar.index.folderWorkspaces')",
      "type T = AppState['detectedWorktreesByRepo']",
      'const rows = selectWorktreesByRepo(state)'
    ].join('\n')
    expect(countWorkspaceRecordReads(text)).toBe(0)
  })
})

describe('isScannedFile', () => {
  it('scans renderer sources but not tests or the selector module', () => {
    expect(isScannedFile('src/renderer/src/lib/foo.ts')).toBe(true)
    expect(isScannedFile('src/renderer/src/components/Foo.tsx')).toBe(true)
    expect(isScannedFile('src/renderer/src/lib/foo.test.ts')).toBe(false)
    expect(isScannedFile('src/renderer/src/lib/foo.test-fixture.ts')).toBe(false)
    for (const file of SELECTOR_FILES.keys()) {
      expect(isScannedFile(file)).toBe(false)
    }
  })
})
