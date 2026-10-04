import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  readOpenCodeOverlayManifest,
  OPENCODE_OVERLAY_MANIFEST_FILE
} from './opencode-overlay-manifest'

it('accepts only string manifest entries and tolerates invalid persisted shapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-overlay-manifest-'))
  try {
    const path = join(root, OPENCODE_OVERLAY_MANIFEST_FILE)
    for (const text of ['null', '1', '{']) {
      writeFileSync(path, text)
      expect(readOpenCodeOverlayManifest(root)).toEqual({ topLevelEntries: [], pluginEntries: [] })
    }
    writeFileSync(
      path,
      JSON.stringify({
        topLevelEntries: ['valid', 1, null],
        pluginEntries: [{ bad: true }, 'plugin.js']
      })
    )
    expect(readOpenCodeOverlayManifest(root)).toEqual({
      topLevelEntries: ['valid'],
      pluginEntries: ['plugin.js']
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
