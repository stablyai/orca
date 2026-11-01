import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_AUTHORING_COMMAND_SPECS,
  PLUGIN_RUNTIME_COMMAND_SPECS
} from '../../src/cli/specs/plugin'
import {
  buildPluginAuthoringReferences,
  findStalePluginAuthoringReferences
} from './generate-plugin-authoring-skill-references.mjs'

const projectDir = path.resolve(import.meta.dirname, '..', '..')
describe('plugin authoring skill references', () => {
  it('checks in the references generated from the plugin sources', async () => {
    const artifacts = await buildPluginAuthoringReferences(projectDir)

    // Run `pnpm generate:plugin-authoring-skill-references` when this fails.
    await expect(findStalePluginAuthoringReferences(artifacts, projectDir)).resolves.toEqual([])
  })

  it('reports a stale reference by its repo path', async () => {
    const [first, ...rest] = await buildPluginAuthoringReferences(projectDir)
    const stale = [{ ...first, content: `${first.content}drift\n` }, ...rest]

    await expect(findStalePluginAuthoringReferences(stale, projectDir)).resolves.toEqual([
      'skill-guides/orca-plugin-authoring/references/cli.md'
    ])
  })

  it('names only plugin commands this CLI defines, outside the pending test/check section', async () => {
    const guide = await readFile(
      path.join(projectDir, 'skill-guides', 'orca-plugin-authoring.md'),
      'utf8'
    )
    const known = [...PLUGIN_AUTHORING_COMMAND_SPECS, ...PLUGIN_RUNTIME_COMMAND_SPECS].map((spec) =>
      spec.path.join(' ')
    )
    const named = [...guide.matchAll(/ORCA (plugin(?: [a-z-]+){1,2})/gu)].map((match) => match[1])
    const unknown = named.filter(
      (command) => !known.some((path) => command === path || command.startsWith(`${path} `))
    )

    expect(named.length).toBeGreaterThan(5)
    expect(unknown).toEqual([])
  })
})
