import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validatePluginTarget } from './plugin-folder-validation'
import { checkPluginPanels } from './plugin-panel-check'

const FIXTURE = resolve(__dirname, '../../../../examples/plugins/panel-icons')

describe('panel icon fixture', () => {
  it('passes validate for built-in, emoji and file icons', async () => {
    const report = await validatePluginTarget(FIXTURE)

    expect(report).toMatchObject({ kind: 'plugin', valid: true, errors: [] })
  })

  it('passes plugin check for all three panels', async () => {
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
      { panel: 'emoji', elements: 1, issues: [], warnings: [] },
      { panel: 'file', elements: 1, issues: [], warnings: [] }
    ])
  }, 60_000)
})
