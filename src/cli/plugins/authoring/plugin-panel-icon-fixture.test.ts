import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validatePluginTarget } from './plugin-folder-validation'
import { checkPluginPanels } from './plugin-panel-check'

const FIXTURE = resolve(__dirname, '../../../../examples/plugins/panel-icons')

describe('panel icon fixture', () => {
  it('passes validate for built-in and file icons', async () => {
    const report = await validatePluginTarget(FIXTURE)

    expect(report).toMatchObject({ kind: 'plugin', valid: true, errors: [] })
  })

  // Why 60s: checking a components panel boots a sandboxed renderer worker.
  it('passes plugin check for both panels', async () => {
    const checks = await checkPluginPanels(FIXTURE)
    expect(
      checks.map(({ panel, elements, issues, warnings }) => ({
        panel,
        elements,
        issues,
        warnings
      }))
    ).toEqual([
      { panel: 'builtin', elements: 1, issues: [], warnings: [] },
      { panel: 'file', elements: 1, issues: [], warnings: [] }
    ])
  }, 60_000)
})
