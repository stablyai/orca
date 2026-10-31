import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverClaudePluginSkillSources } from './claude-plugin-skill-sources'

function installedPlugins(installs: Record<string, Record<string, unknown>[]>): string {
  return JSON.stringify({ version: 2, plugins: installs })
}

function settings(enabledPlugins: Record<string, boolean>): string {
  return JSON.stringify({ enabledPlugins })
}

describe('Claude plugin skill sources', () => {
  const pluginId = 'compound-engineering@compound-engineering-plugin'

  it('propagates cancellation before metadata access instead of treating it as missing settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-plugin-abort-'))
    try {
      const controller = new AbortController()
      const reason = new Error('plugin discovery cancelled')
      controller.abort(reason)
      await expect(
        discoverClaudePluginSkillSources({
          homeDir: directory,
          cwd: directory,
          signal: controller.signal
        })
      ).rejects.toBe(reason)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads owned metadata normally with a non-aborted signal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-plugin-active-'))
    try {
      const plugins = join(directory, '.claude', 'plugins')
      const installPath = join(directory, 'installed-plugin')
      await mkdir(plugins, { recursive: true })
      await writeFile(
        join(plugins, 'installed_plugins.json'),
        installedPlugins({ [pluginId]: [{ scope: 'user', installPath }] })
      )
      await writeFile(join(directory, '.claude', 'settings.json'), settings({ [pluginId]: true }))
      const roots = await discoverClaudePluginSkillSources({
        homeDir: directory,
        cwd: directory,
        signal: new AbortController().signal
      })
      expect(roots.map((root) => root.path)).toEqual([join(installPath, 'skills')])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
