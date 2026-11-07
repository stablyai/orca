import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))

import { runVendorHook } from './vendor-hook-delivery.test-fixture'

import { getManagedScript as getClaudeManagedScript } from '../claude/hook-service'
import { getManagedScript as getCursorManagedScript } from '../cursor/hook-script'

const CLAUDE_SCRIPT_OPTIONS = {
  skipWhenDevinImportsClaude: true,
  skipWhenGrokImportsClaude: true,
  skipWhenCursorImportsClaude: true
}
const CURSOR_ENV = { CURSOR_VERSION: '2026.10.16', CURSOR_PROJECT_DIR: '/work/project' }

describe('Cursor vendor hook replay guard', () => {
  it('drops imported Claude events while preserving the hook protocol response', async () => {
    expect(
      (await runVendorHook(getClaudeManagedScript('local', CLAUDE_SCRIPT_OPTIONS), CURSOR_ENV))
        .requests
    ).toEqual([])
  })

  it('keeps Cursor native hooks reporting in the same environment', async () => {
    expect((await runVendorHook(getCursorManagedScript('local'), CURSOR_ENV)).requests).toEqual([
      '/hook/cursor'
    ])
  })
})
