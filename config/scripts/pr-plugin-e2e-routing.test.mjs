import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyE2eJobs, generalE2eShards } from './ci-e2e-job-selection.mjs'
import { testImportClosure } from './e2e-test-import-closure.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'
import {
  PLUGIN_SYSTEM_SOURCE,
  PR_PLUGIN_E2E_SOURCE_ROUTES
} from './pr-plugin-e2e-source-routes.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const UNROUTED_ID = 'plugins.unrouted-source'

function repoFiles(directory) {
  return readdirSync(join(projectDir, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(projectDir.length + 1))
    .map((file) => file.split('\\').join('/'))
}

const pluginSources = [
  ...repoFiles('src/renderer/src/components/plugins'),
  ...repoFiles('src/main/plugins'),
  ...repoFiles('src/shared/plugins'),
  ...readdirSync(join(projectDir, 'src/renderer/src/store'))
    .filter((name) => name.startsWith('plugin-'))
    .map((name) => `src/renderer/src/store/${name}`)
].filter(
  (file) =>
    /\.(?:ts|tsx|cjs)$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes('/__mocks__/')
)

const pluginSpecs = readdirSync(join(projectDir, 'tests/e2e'))
  .filter((name) => /^plugin-.*\.spec\.ts$/.test(name))
  .map((name) => `tests/e2e/${name}`)

const routedPluginSpecs = (file) =>
  PR_PLUGIN_E2E_SOURCE_ROUTES.filter((route) => route.matches(file)).flatMap((route) => route.specs)

describe('plugin PR E2E routing', () => {
  it('runs the update review specs for the #36218 change set', () => {
    const specs = selectPrE2eSpecs([
      'src/renderer/src/components/plugins/dialogs/PluginUpdateAllDialog.tsx',
      'src/renderer/src/components/plugins/list/PluginsAlphaNotice.tsx',
      'src/renderer/src/components/plugins/page/PluginDetailPage.tsx',
      'src/renderer/src/components/plugins/presentation/plugin-publisher-trust.ts',
      'src/renderer/src/components/plugins/review/PluginUpdateReview.tsx',
      'src/renderer/src/components/plugins/state/use-plugin-page-model.ts'
    ])
    expect(specs).toContain('tests/e2e/plugin-update-review.spec.ts')
    expect(specs).toContain('tests/e2e/plugin-update-review-toast.spec.ts')
    expect(classifyE2eJobs(JSON.stringify(specs)).e2e_run_changed).toBe(true)
  })

  it.each([
    ['src/renderer/src/components/plugins/review/PluginInstallConsent.tsx', 'plugin-update-review'],
    ['src/renderer/src/components/plugins/catalog/PluginCardAction.tsx', 'plugin-install-link'],
    ['src/renderer/src/components/plugins/state/plugin-try-action.ts', 'plugin-try-it'],
    ['src/renderer/src/store/plugin-themes.ts', 'plugin-theme-smoke'],
    ['src/renderer/src/store/plugin-syntax-packs.ts', 'plugin-syntax-smoke'],
    ['src/renderer/src/store/plugin-custom-editors.ts', 'plugin-custom-editor'],
    ['src/main/plugins/panels/plugin-panel-controller.ts', 'plugin-panel-containment'],
    ['src/main/plugins/catalog/plugin-file-type-suggestion.ts', 'plugin-file-type-suggestion'],
    ['src/main/plugins/catalog/plugin-auto-updater.ts', 'plugin-update-review-toast'],
    ['src/shared/plugins/manifest/plugin-manifest.ts', 'plugin-startup-budget']
  ])('routes %s to %s', (file, spec) => {
    expect(selectPrE2eSpecs([file])).toContain(`tests/e2e/${spec}.spec.ts`)
  })

  it('routes every plugin product source to at least one plugin spec', () => {
    expect(pluginSources.length).toBeGreaterThan(100)
    for (const file of pluginSources) {
      expect(routedPluginSpecs(file).length, file).toBeGreaterThan(0)
    }
    expect(routedPluginSpecs('src/main/plugins/plugin-future-feature.ts')).toEqual([
      'tests/e2e/plugin-demo.spec.ts'
    ])
  })

  it('leaves the unrouted fallback for sources no specific route names', () => {
    const fallback = PR_PLUGIN_E2E_SOURCE_ROUTES.find((route) => route.id === UNROUTED_ID)
    const caught = pluginSources.filter(fallback.matches)
    // Grows only when a plugin source lands without a targeted route; add one instead.
    expect(caught.length, caught.join('\n')).toBeLessThan(pluginSources.length / 10)
  })

  it('gives every plugin spec a source route, and every routed spec exists', () => {
    const routed = new Set(PR_PLUGIN_E2E_SOURCE_ROUTES.flatMap((route) => route.specs))
    for (const spec of routed) {
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
    }
    expect([...routed].sort()).toEqual(pluginSpecs.sort())
  })

  it('routes each plugin spec from every plugin helper it imports', () => {
    for (const spec of pluginSpecs) {
      const helpers = testImportClosure(projectDir, [spec]).filter((file) =>
        file.startsWith('tests/e2e/helpers/plugin-')
      )
      for (const helper of helpers) {
        expect(selectPrE2eSpecs([helper]), `${helper} -> ${spec}`).toContain(spec)
      }
    }
  })

  it('keeps plugin selections in one changed-spec shard', () => {
    const everything = selectPrE2eSpecs(
      pluginSources.filter((file) => PLUGIN_SYSTEM_SOURCE.test(file))
    )
    expect(everything.filter((spec) => !pluginSpecs.includes(spec))).toEqual([])
    expect(generalE2eShards(JSON.stringify(everything))).toEqual(['1/1'])
    for (const file of pluginSources) {
      expect(new Set(routedPluginSpecs(file)).size, file).toBeLessThanOrEqual(4)
    }
  })

  it('leaves unit tests and unrelated sources alone', () => {
    for (const file of [
      'src/renderer/src/components/plugins/review/PluginUpdateReview.test.tsx',
      'src/main/plugins/plugin-service.test.ts',
      'src/main/plugins/__mocks__/plugin-git-ssh-remote-fixture.ts',
      'src/renderer/src/components/settings/GeneralPane.tsx',
      'src/main/ipc/filesystem.ts'
    ]) {
      expect(routedPluginSpecs(file), file).toEqual([])
    }
  })
})
