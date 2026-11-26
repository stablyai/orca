import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginCliError } from '../../../../../shared/plugins/approval/plugin-cli-approval'
import type { PluginLockEntry } from '../../../../../shared/plugins/installation/plugin-install-lockfile'
import { marketplaceSourceId } from '../../../../plugins/catalog/plugin-marketplace-store'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { PLUGIN_INSTALL_METHODS, setPluginInstallServicesForRpc } from './plugin-install-methods'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin handlers never touch the runtime.
const context: RpcContext = { runtime: {} as RpcContext['runtime'], caller: { kind: 'local-cli' } }

const CATALOG = { url: 'https://github.com/acme/catalog.git', ref: 'main' }

function lockEntry(pluginKey: string, source: PluginLockEntry['source']): PluginLockEntry {
  return {
    pluginKey,
    version: '1.0.0',
    source,
    resolvedCommit: null,
    contentHash: 'a'.repeat(64),
    consentFingerprint: 'fingerprint',
    installedAt: 0
  }
}

function useLock(entries: PluginLockEntry[], catalogIds: string[] = []): void {
  const plugins = Object.fromEntries(entries.map((entry) => [entry.pluginKey, entry]))
  setPluginInstallServicesForRpc({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these updates only read the system switch and host paths.
    pluginService: {
      whenReady: async () => {},
      options: { isPluginSystemEnabled: () => true, userDataPath: tmpdir(), hostVersion: '1.0.0' }
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pinned, folder and unlisted catalog updates only read the lockfile and catalog cache.
    catalogs: {
      marketplace: {
        listSources: async () =>
          catalogIds.map((id) => ({ id, source: { url: CATALOG.url }, marketplace: null })),
        refreshSource: async () => {},
        findPlugin: async () => null
      },
      installer: {
        readInstallLockfile: async () => ({ version: 1, plugins }),
        previewInstalledUpdate: async (pluginKey: string) => {
          throw new Error(`plugin ${pluginKey} is not listed by marketplace`)
        }
      }
    } as never,
    applyConsent: async () => {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: updates never touch settings.
    store: {} as never
  })
}

const ORPHAN = lockEntry('acme.orphan', {
  kind: 'marketplace',
  marketplace: { ...CATALOG, resolvedCommit: 'c'.repeat(40) },
  plugin: { url: 'https://github.com/acme/orphan.git', ref: 'main' }
})

const DROPPED_CATALOG_CASES: [string, string[]][] = [
  ['was removed', []],
  ['no longer lists it', [marketplaceSourceId({ kind: 'git', ...CATALOG })]]
]

function updateMethod() {
  const method = eraseRpcMethods(PLUGIN_INSTALL_METHODS).find(
    (entry) => entry.name === 'plugins.update'
  )
  if (!method || 'stream' in method) {
    throw new Error('plugins.update is missing')
  }
  return method
}

afterEach(() => setPluginInstallServicesForRpc(null))

describe('plugins.update', () => {
  it('--all returns the failed updates next to the other outcomes', async () => {
    const missing = join(tmpdir(), 'orca-missing-plugin-folder-46698')
    useLock([
      lockEntry('acme.pinned', {
        kind: 'git',
        url: 'https://github.com/acme/pinned.git',
        ref: 'b'.repeat(40)
      }),
      lockEntry('acme.bad', { kind: 'local-path', path: missing })
    ])

    await expect(updateMethod().handler({ all: true }, context)).resolves.toMatchObject({
      updates: [{ status: 'pinned', pluginKey: 'acme.pinned' }],
      approvals: [],
      failed: [{ pluginKey: 'acme.bad', code: 'invalid_argument' }]
    })
  })

  it.each(DROPPED_CATALOG_CASES)(
    '--all settles a plugin whose catalog %s instead of failing',
    async (_case, catalogIds) => {
      useLock([ORPHAN], catalogIds)

      await expect(updateMethod().handler({ all: true }, context)).resolves.toMatchObject({
        updates: [{ status: 'pinned', pluginKey: 'acme.orphan' }],
        failed: []
      })
    }
  )

  it.each(DROPPED_CATALOG_CASES)(
    'a single update still fails for a plugin whose catalog %s',
    async (_case, catalogIds) => {
      useLock([ORPHAN], catalogIds)

      const update = updateMethod().handler({ pluginKey: 'acme.orphan' }, context)

      await expect(update).rejects.toBeInstanceOf(PluginCliError)
      await expect(update).rejects.toMatchObject({ code: 'plugin_install_failed' })
    }
  )
})
