import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))

import { getManagedScript as getClaudeManagedScript } from '../../../claude/hooks/hook-script'
import { getManagedScript as getCursorManagedScript } from '../../../cursor/hook-script'
import { runVendorHook } from './testing/vendor-hook-delivery.test-fixture'

const CLAUDE_SCRIPT_OPTIONS = {
  skipWhenDevinImportsClaude: true,
  skipWhenGrokImportsClaude: true
}

describe('Grok vendor hook replay guard', () => {
  it('drops Grok-replayed hooks without suppressing their protocol response', async () => {
    for (const script of [
      getClaudeManagedScript('local', CLAUDE_SCRIPT_OPTIONS),
      getCursorManagedScript('local')
    ]) {
      expect((await runVendorHook(script, { GROK_HOOK_EVENT: 'Stop' })).requests).toEqual([])
    }
  })

  it.skipIf(process.platform === 'win32')(
    'keeps Grok-replayed hooks out of the spool',
    async () => {
      for (const [source, script] of [
        ['claude', getClaudeManagedScript('posix', CLAUDE_SCRIPT_OPTIONS)],
        ['cursor', getCursorManagedScript('posix')]
      ]) {
        const ordinary = await runVendorHook(script, { GROK_HOOK_EVENT: '' }, 'spool')
        expect(ordinary.requests).toEqual([])
        expect(ordinary.spooled).toHaveLength(1)
        expect(JSON.parse(ordinary.spooled[0])).toMatchObject({
          source,
          paneKey: 'tab:leaf',
          payload: { hook_event_name: 'Stop' }
        })
        const replayed = await runVendorHook(script, { GROK_HOOK_EVENT: 'Stop' }, 'spool')
        expect(replayed.requests).toEqual([])
        expect(replayed.spooled).toEqual([])
      }
    }
  )
})
