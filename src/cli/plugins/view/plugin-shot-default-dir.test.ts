import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultPluginShotsDir, enclosingPluginFolder } from './plugin-shot-default-dir'

const ROOT = join('/', 'work', 'repo')
const PLUGIN = join(ROOT, 'plugins', 'todos')

function filesystem(...paths: string[]): (path: string) => boolean {
  const present = new Set(paths)
  return (path) => present.has(path)
}

describe('plugin shot default folder', () => {
  it('finds the plugin folder from inside it, up to the repository root', () => {
    const exists = filesystem(join(PLUGIN, 'orca-plugin.json'), join(ROOT, '.git'))
    expect(enclosingPluginFolder(join(PLUGIN, 'src', 'panels'), exists)).toBe(PLUGIN)
    expect(defaultPluginShotsDir(PLUGIN, exists)).toBe(join(PLUGIN, '.orca', 'shots'))
  })

  it('keeps <cwd>/.orca/shots elsewhere, and never looks above the repository root', () => {
    const exists = filesystem(join('/', 'work', 'orca-plugin.json'), join(ROOT, '.git'))
    expect(enclosingPluginFolder(join(ROOT, 'docs'), exists)).toBeNull()
    expect(defaultPluginShotsDir(join(ROOT, 'docs'), exists)).toBe(
      join(ROOT, 'docs', '.orca', 'shots')
    )
    expect(enclosingPluginFolder(join('/', 'tmp'), filesystem())).toBeNull()
  })
})
