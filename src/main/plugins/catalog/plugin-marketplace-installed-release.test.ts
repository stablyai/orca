import '../../persistence/persistence-test-harness'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applyPluginConsent } from '../activation/plugin-enablement'
import { installStagedPluginTree } from '../installation/plugin-install-staging'
import {
  createMarketplaceReviewFixture,
  disposeMarketplaceReviewFixtures,
  REVIEW_CATALOG,
  REVIEW_ENTRY,
  REVIEW_KEY
} from './plugin-marketplace-review.test-fixture'

afterEach(disposeMarketplaceReviewFixtures)

it.each([
  'unchanged',
  'new-commit',
  'retained',
  'moved-source',
  'withdrawn',
  'replaced-bytes'
] as const)(
  'checks currently vouched installed bytes through a newer catalog (%s)',
  async (offer) => {
    const f = await createMarketplaceReviewFixture()
    f.service.options.hostVersion = '1.4.300'
    const tree = await f.tree('1.0.0')
    await writeFile(
      join(tree, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        id: 'demo',
        publisher: 'samples',
        name: 'demo',
        version: '1.0.0',
        execution: 'data',
        license: 'MIT',
        engines: { orca: '>=1.4.248' },
        capabilities: [],
        contributes: {}
      })
    )
    const installed = await installStagedPluginTree({
      pluginsDir: f.pluginsDir,
      stagingDir: tree,
      hostVersion: '1.4.300',
      source: {
        kind: 'marketplace',
        marketplace: {
          url: REVIEW_CATALOG.url,
          ref: REVIEW_CATALOG.ref,
          resolvedCommit: 'c'.repeat(40)
        },
        plugin: REVIEW_ENTRY.source
      },
      resolvedCommit: 'a'.repeat(40),
      identity: { pluginKey: REVIEW_KEY }
    })
    if (!installed.ok) {
      throw new Error(installed.error)
    }
    await f.service.refresh()
    const release = {
      version: '1.0.0',
      commit: 'a'.repeat(40),
      contentHash: installed.contentHash,
      execution: 'data' as const,
      minimumOrca: '1.4.248'
    }
    const other = {
      ...release,
      version: '1.1.0',
      commit: 'e'.repeat(40),
      contentHash: 'f'.repeat(64)
    }
    await f.refresh(
      offer === 'withdrawn'
        ? []
        : [
            {
              ...REVIEW_ENTRY,
              source:
                offer === 'moved-source'
                  ? { ...REVIEW_ENTRY.source, url: 'https://github.com/samples/moved.git' }
                  : REVIEW_ENTRY.source,
              releases:
                offer === 'retained'
                  ? [other, release]
                  : [
                      offer === 'new-commit'
                        ? { ...release, commit: 'e'.repeat(40) }
                        : offer === 'replaced-bytes'
                          ? { ...release, contentHash: 'f'.repeat(64) }
                          : release
                    ]
            }
          ]
    )
    const approval = applyPluginConsent({
      store: f.store,
      pluginService: f.service,
      pluginKey: REVIEW_KEY,
      reviewedFingerprint: installed.consentFingerprint,
      decision: 'approve'
    })
    const refused = offer === 'withdrawn' || offer === 'replaced-bytes'
    await (refused ? expect(approval).rejects.toThrow('review the plugin again') : approval)
    expect(f.store.getSettings().pluginConsents).toEqual(
      refused ? {} : { [REVIEW_KEY]: installed.consentFingerprint }
    )
  }
)
