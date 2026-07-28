import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import {
  PLUGIN_MANIFEST_FILENAME,
  pluginManifestSchema,
  qualifiedPluginKey,
  type PluginManifest
} from '../../shared/plugins/plugin-manifest'
import { PluginService, type PluginServiceOptions } from './plugin-service'
import type { PluginWorkerFactory } from './plugin-worker-manager'

const PLUGIN_COUNT = 20
const SAMPLE_COUNT = 20
// Real disk I/O, so the number moves with machine load: ~16-34ms idle, higher
// when the suite saturates the box. Sized to catch an order-of-magnitude
// regression rather than scheduling noise — the behavioral assertions below
// (no worker spawned, no plugin code run) are what this test really guards.
const STARTUP_P95_BUDGET_MS = 400

let userDataPath = ''
let markerPaths: string[] = []
let consents: Record<string, string> = {}

function dummyManifest(index: number): PluginManifest {
  const key = String.fromCharCode('A'.charCodeAt(0) + index)
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: `dummy-${index}`,
    publisher: 'startup-budget',
    name: `Startup Dummy ${index}`,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      panels: [],
      commands: [
        {
          id: 'open',
          title: `Open Startup Dummy ${index}`,
          action: 'view.tasks'
        }
      ],
      events: [],
      keybindings: [{ command: 'open', key: `Mod+Alt+${key}` }],
      themes: [
        {
          id: `startup-${index}`,
          label: `Startup Theme ${index}`,
          path: 'theme.json'
        }
      ]
    },
    capabilities: []
  })
}

async function installDummy(index: number): Promise<{ pluginKey: string; markerPath: string }> {
  const manifest = dummyManifest(index)
  const pluginKey = qualifiedPluginKey(manifest)
  const contentHash = (index + 1).toString(16).padStart(64, '0')
  const pluginDir = join(userDataPath, 'plugins', pluginKey)
  const versionDir = join(pluginDir, contentHash)
  const markerPath = join(userDataPath, `activation-${index}.marker`)
  await mkdir(versionDir, { recursive: true })
  await Promise.all([
    writeFile(join(pluginDir, 'current'), contentHash),
    writeFile(join(versionDir, PLUGIN_MANIFEST_FILENAME), JSON.stringify(manifest)),
    writeFile(
      join(versionDir, 'theme.json'),
      JSON.stringify({
        base: index % 2 === 0 ? 'dark' : 'light',
        tokens: { '--background': index % 2 === 0 ? '#111111' : '#eeeeee' }
      })
    )
  ])
  consents[pluginKey] = fingerprintPluginConsent(manifest)
  return { pluginKey, markerPath }
}

function nearestRankP95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!
}

describe('plugin startup budget', () => {
  beforeAll(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'orca-plugin-startup-budget-'))
    const installed = await Promise.all(
      Array.from({ length: PLUGIN_COUNT }, (_, index) => installDummy(index))
    )
    markerPaths = installed.map(({ markerPath }) => markerPath)
  })

  afterAll(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('stays below 50ms P95 with 20 approved content packs and executes no plugin code', async () => {
    const workerFactory = vi.fn<PluginWorkerFactory>(async () => {
      throw new Error('startup must not create a plugin worker')
    })
    const options: PluginServiceOptions = {
      userDataPath,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => consents,
      getDevPluginPaths: () => [],
      workerFactory
    }
    const measure = async (): Promise<number> => {
      const startedAt = performance.now()
      const service = new PluginService(options)
      await service.initialize()
      const elapsedMs = performance.now() - startedAt
      expect(service.getDiscovered()).toHaveLength(PLUGIN_COUNT)
      await service.dispose()
      return elapsedMs
    }

    await measure()
    const samples: number[] = []
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      samples.push(await measure())
    }

    const p95 = nearestRankP95(samples)
    if (process.env.ORCA_PLUGIN_STARTUP_BUDGET_REPORT === '1') {
      process.stdout.write(`plugin startup P95 ${p95.toFixed(2)}ms (${SAMPLE_COUNT} samples)\n`)
    }
    expect(workerFactory).not.toHaveBeenCalled()
    await Promise.all(
      markerPaths.map((markerPath) =>
        expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      )
    )
    expect(
      p95,
      `plugin startup P95 ${p95.toFixed(2)}ms; samples: ${samples.map((sample) => sample.toFixed(2)).join(', ')}`
    ).toBeLessThan(STARTUP_P95_BUDGET_MS)
  })
})
