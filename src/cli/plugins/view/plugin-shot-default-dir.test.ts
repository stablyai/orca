import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultPluginShotsDir, enclosingPluginFolder } from './plugin-shot-default-dir'

const ROOT = join('/', 'work', 'repo')

function filesystem(...paths: string[]): (path: string) => boolean {
  const present = new Set(paths)
  return (path) => present.has(path)
}

describe('plugin shot default folder', () => {
  it('keeps <cwd>/.orca/shots elsewhere, and never looks above the repository root', () => {
    const exists = filesystem(join('/', 'work', 'orca-plugin.json'), join(ROOT, '.git'))
    expect(enclosingPluginFolder(join(ROOT, 'docs'), exists)).toBeNull()
    expect(defaultPluginShotsDir(join(ROOT, 'docs'), exists)).toBe(
      join(ROOT, 'docs', '.orca', 'shots')
    )
    expect(enclosingPluginFolder(join('/', 'tmp'), filesystem())).toBeNull()
  })
})
