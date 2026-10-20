import { describe, expect, it, vi } from 'vitest'
import {
  registerPersistedContentScripts,
  restorePersistedContentScripts
} from './browser-extension-content-script-restore'

function fakeChrome() {
  const registered: string[] = []
  const runtime: { lastError?: { message: string } } = {}
  const chrome = {
    runtime,
    scripting: {
      registerContentScripts(scripts: { id: string }[], callback: () => void) {
        chrome.runtime.lastError =
          scripts[0].id === 'dupe' ? { message: 'Duplicate script ID' } : undefined
        registered.push(scripts[0].id)
        callback()
        chrome.runtime.lastError = undefined
      }
    }
  }
  return { chrome, registered }
}

describe('persisted content script restore', () => {
  it('registers each script alone and reports the failures', async () => {
    const { chrome, registered } = fakeChrome()
    const failures = await registerPersistedContentScripts({ chrome }, [
      { id: 'keep' },
      { id: 'dupe' }
    ])
    expect(registered).toEqual(['keep', 'dupe'])
    expect(failures).toBe(1)
  })

  it('takes the scripts from main, registers them in the worker, and reports back', async () => {
    const { chrome, registered } = fakeChrome()
    const invoke = vi.fn(async (request: unknown) => ({
      ok: true as const,
      value:
        request && typeof request === 'object' && 'method' in request && request.method === 'take'
          ? [{ id: 'keep' }, { id: 'dupe' }]
          : undefined
    }))
    await restorePersistedContentScripts(invoke, { chrome })
    expect(registered).toEqual(['keep', 'dupe'])
    expect(invoke).toHaveBeenLastCalledWith({
      type: 'call',
      namespace: 'orcaContentScriptRestore',
      method: 'done',
      args: [1]
    })
  })

  it('asks main once and registers nothing when there is nothing to restore', async () => {
    const { chrome, registered } = fakeChrome()
    const invoke = vi.fn(async () => ({ ok: true as const, value: [] }))
    await restorePersistedContentScripts(invoke, { chrome })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith({
      type: 'call',
      namespace: 'orcaContentScriptRestore',
      method: 'take',
      args: []
    })
    expect(registered).toEqual([])
  })
})
