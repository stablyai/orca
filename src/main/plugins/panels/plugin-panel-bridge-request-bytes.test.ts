import { describe, expect, it, vi } from 'vitest'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import type { PluginWorkerHandle } from '../workers/parent-process/plugin-host-process-types'
import { PluginPanelBridge } from './plugin-panel-bridge'

const MIB = 1024 * 1024
const caller = { id: 'panel-a', surface: 'editor' as const, contributionId: 'waves' }

/** `plugin.requestBytes` through a bridge whose worker answers with `answer`. */
function requestBytes(answer: unknown): Promise<ArrayBuffer> {
  const bridge = new PluginPanelBridge({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge reads only `manifest.main`.
    findApprovedPlugin: () => ({ manifest: { main: 'worker.mjs' } }) as ValidDiscoveredPlugin,
    grantedCapabilities: () => [],
    ensureWorker: async () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a request reaches only `requestFromPanel`.
      ({ requestFromPanel: async () => answer }) as unknown as PluginWorkerHandle,
    runningWorker: () => null,
    log: () => vi.fn()
  })
  return bridge.requestBytes({ pluginKey: 'acme.waves', caller, name: 'signal.read', input: null })
}

describe('plugin.requestBytes answers', () => {
  it('hands over an ArrayBuffer of 2 MiB and refuses one byte more', async () => {
    const largest = new ArrayBuffer(2 * MIB)
    await expect(requestBytes(largest)).resolves.toBe(largest)
    await expect(requestBytes(new ArrayBuffer(2 * MIB + 1))).rejects.toMatchObject({
      code: 'too_large'
    })
  })

  it('refuses an answer that is not an ArrayBuffer', async () => {
    await expect(requestBytes({ rows: 3 })).rejects.toMatchObject({ code: 'action_failed' })
  })
})
