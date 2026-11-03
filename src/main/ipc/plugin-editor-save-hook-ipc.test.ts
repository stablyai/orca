import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookChainOutcome } from '../../shared/plugins/workers/plugin-hook-chain'
import { setPluginHookRunner } from '../plugins/hooks/plugin-hook-dispatch'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) }
}))

import { registerPluginEditorSaveHookHandler } from './plugin-editor-save-hook-ipc'

const save = { workspaceId: 'wt-1', path: 'src/a.ts', languageId: 'typescript', text: '  x  ' }

function answer(payload: unknown) {
  registerPluginEditorSaveHookHandler()
  return handlers.get('plugins:editorSaveHook')!({}, payload)
}

function runner(outcome: (payload: unknown) => PluginHookChainOutcome) {
  setPluginHookRunner({ wants: () => true, run: async (_event, payload) => outcome(payload) })
}

afterEach(() => {
  setPluginHookRunner(null)
})

describe('plugins:editorSaveHook', () => {
  it('answers the text the chain decided', async () => {
    runner((payload) => ({ kind: 'continue', payload: { ...Object(payload), text: 'x\n' } }))
    await expect(answer(save)).resolves.toEqual({ kind: 'continue', text: 'x\n' })
  })

  it('answers a deny with the plugin and its reason', async () => {
    runner(() => ({ kind: 'deny', pluginKey: 'acme.fmt', reason: 'syntax error' }))
    await expect(answer(save)).resolves.toEqual({
      kind: 'deny',
      pluginKey: 'acme.fmt',
      reason: 'syntax error'
    })
  })

  it('passes a buffer the hook cannot carry, and with no plugin listening', async () => {
    await expect(answer({ ...save, path: '' })).resolves.toEqual({ kind: 'continue', text: null })
    await expect(answer(save)).resolves.toEqual({ kind: 'continue', text: save.text })
  })
})
