import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../../shared/plugins/plugin-host-version'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../shared/plugins/manifest/plugin-schema-field-docs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUserPluginsDir } from './plugin-discovery'
import { listPluginsForClients, readInstalledPluginManifest } from './plugin-client-list'
import type { PluginService } from './plugin-service'

const roots: string[] = []

async function userDataWithInstalledPlugin(): Promise<string> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-plugin-client-list-'))
  roots.push(userDataPath)
  const hash = 'a'.repeat(64)
  const pluginDir = join(getUserPluginsDir(userDataPath), 'acme.notes')
  await mkdir(join(pluginDir, hash), { recursive: true })
  await writeFile(join(pluginDir, 'current'), hash)
  await writeFile(
    join(pluginDir, hash, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'data',
      id: 'notes',
      publisher: 'acme',
      name: 'Notes',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      license: 'MIT'
    })
  )
  return userDataPath
}

function serviceOff(userDataPath: string) {
  const getDiscovered = vi.fn(() => [])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list reads only the members stubbed here.
  const service = {
    options: {
      isPluginSystemEnabled: () => false,
      isFullAccessAllowed: () => true,
      userDataPath,
      hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE,
      getDevPluginPaths: () => [],
      getPluginConsents: () => ({}),
      getDisabledPlugins: () => []
    },
    whenReady: async () => undefined,
    getDiscovered,
    activationState: () => 'disabled',
    workerState: () => ({ state: 'inactive', restarts: 0 }),
    activationError: () => null,
    contentPacks: {
      vmRecipes: { preview: () => [] },
      commands: { preview: () => [] }
    }
  } as unknown as PluginService
  return { service, getDiscovered }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugin client list with the plugin system off', () => {
  it('lists installed plugins read-only as disabled', async () => {
    const { service, getDiscovered } = serviceOff(await userDataWithInstalledPlugin())

    const plugins = await listPluginsForClients(service)

    expect(plugins).toMatchObject([
      { pluginKey: 'acme.notes', name: 'Notes', status: 'disabled', license: 'MIT' }
    ])
    // Why: the live registry stays empty while off; the read must not populate or activate it.
    expect(getDiscovered).not.toHaveBeenCalled()
  })

  it('reads one installed manifest on demand', async () => {
    const { service } = serviceOff(await userDataWithInstalledPlugin())

    await expect(readInstalledPluginManifest(service, 'acme.notes')).resolves.toMatchObject({
      name: 'Notes',
      execution: 'data'
    })
    await expect(readInstalledPluginManifest(service, 'acme.missing')).resolves.toBeNull()
  })
})
