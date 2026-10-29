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

  it.each([{}, { CURSOR_VERSION: CURSOR_ENV.CURSOR_VERSION }, { CURSOR_PROJECT_DIR: '/p' }])(
    'still delivers Claude hooks when only part of the Cursor environment is present: %j',
    async (env) => {
      expect(
        (await runVendorHook(getClaudeManagedScript('local', CLAUDE_SCRIPT_OPTIONS), env)).requests
      ).toEqual(['/hook/claude'])
    }
  )

  it('keeps Cursor native hooks reporting in the same environment', async () => {
    expect((await runVendorHook(getCursorManagedScript('local'), CURSOR_ENV)).requests).toEqual([
      '/hook/cursor'
    ])
  })

  it('does not suppress a hook service that did not opt in to the Claude import guard', async () => {
    expect((await runVendorHook(getClaudeManagedScript('local'), CURSOR_ENV)).requests).toEqual([
      '/hook/claude'
    ])
  })
})
