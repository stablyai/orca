import { describe, expect, it, vi } from 'vitest'
import {
  parsePluginManifest,
  pluginManifestSchema
} from '../../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from '../workers/plugin-host-process'
import { createPluginHookRunner, pluginHookParticipants } from './plugin-hook-participants'

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'guard',
    name: 'Guard',
    version: '1.0.0',
    engines: { orca: '>=1.4.248' },
    main: 'main.mjs',
    contributes: { hooks: [{ event: 'terminal.send' }] },
    ...overrides
  }
}

function plugin(pluginKey: string, isDev = false, contributes?: unknown): ValidDiscoveredPlugin {
  return {
    pluginKey,
    rootDir: `/plugins/${pluginKey}`,
    manifest: pluginManifestSchema.parse(raw(contributes ? { contributes } : {})),
    consentFingerprint: 'fp',
    contentHash: null,
    isDev
  }
}

describe('contributes.hooks manifest rules', () => {
  it('needs main, refuses duplicates and raises the engines floor', () => {
    expect(parsePluginManifest(raw()).ok).toBe(true)
    expect(parsePluginManifest(raw({ main: undefined }))).toMatchObject({ ok: false })
    expect(
      parsePluginManifest(
        raw({ contributes: { hooks: [{ event: 'terminal.send' }, { event: 'terminal.send' }] } })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('duplicate hook') })
    expect(parsePluginManifest(raw({ engines: { orca: '>=1.4.245' } }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('>=1.4.248')
    })
    expect(parsePluginManifest(raw({ execution: 'sandboxed-ui', main: undefined }))).toMatchObject({
      ok: false
    })
  })
})

describe('pluginHookParticipants', () => {
  it('waits only on approved plugins that list the hook: installed by key, then dev folders', () => {
    const plugins = [
      plugin('zed.guard'),
      plugin('dev.local', true),
      plugin('acme.guard'),
      plugin('acme.other', false, { hooks: [{ event: 'workspace.create.before' }] }),
      plugin('acme.off')
    ]
    const keys = pluginHookParticipants('terminal.send', {
      plugins: () => plugins,
      isRuntimeApproved: (candidate) => candidate.pluginKey !== 'acme.off'
    }).map((candidate) => candidate.pluginKey)
    expect(keys).toEqual(['acme.guard', 'zed.guard', 'dev.local'])
  })

  it('skips a plugin disabled while an earlier hook ran, and logs it', async () => {
    const approved = new Set(['acme.first', 'acme.second'])
    const logs: string[] = []
    const runHook = vi.fn(async (_event: string, payload: unknown) => {
      approved.delete('acme.second')
      return { decision: 'continue', payload }
    })
    const runner = createPluginHookRunner({
      plugins: () => [plugin('acme.first'), plugin('acme.second')],
      isRuntimeApproved: (candidate) => approved.has(candidate.pluginKey),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runner calls only runHook.
      ensureWorker: async () => ({ runHook }) as unknown as PluginWorkerHandle,
      logWarning: (pluginKey) => (line) => void logs.push(`${pluginKey}: ${line}`),
      isEnabled: () => true
    })
    expect(runner.wants('terminal.send')).toBe(true)
    expect(runner.wants('workspace.create.after')).toBe(false)
    const event = { terminalId: 't', text: 'ls', enter: false, inputKind: 'driving' }
    await expect(runner.run('terminal.send', event)).resolves.toEqual({
      kind: 'continue',
      payload: event
    })
    expect(runHook).toHaveBeenCalledOnce()
    expect(logs).toEqual([
      expect.stringMatching(
        /^acme\.second: hook terminal\.send skipped after \d+ms: the plugin is no longer enabled$/
      )
    ])
  })

  it('discards a decision made by a plugin disabled while it ran', async () => {
    let enabled = true
    const logs: string[] = []
    const runHook = vi.fn(async () => {
      enabled = false
      return { decision: 'result', result: { deny: 'late' } }
    })
    const runner = createPluginHookRunner({
      plugins: () => [plugin('acme.slow')],
      isRuntimeApproved: () => enabled,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runner calls only runHook.
      ensureWorker: async () => ({ runHook }) as unknown as PluginWorkerHandle,
      logWarning: (pluginKey) => (line) => void logs.push(`${pluginKey}: ${line}`),
      isEnabled: () => true
    })
    const event = { terminalId: 't', text: 'ls', enter: false, inputKind: 'driving' }
    await expect(runner.run('terminal.send', event)).resolves.toEqual({
      kind: 'continue',
      payload: event
    })
    expect(logs[0]).toMatch(/disabled or changed while its hook ran/)
  })
})
