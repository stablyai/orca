import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer startup runtime routing', () => {
  it('loads settings before repo and worktree hydration', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const startupBlockStart = source.indexOf('void (async () => {')
    const startupBlockEnd = source.indexOf('const persistedUI = await window.api.ui.get()')
    const startupBlock = source.slice(startupBlockStart, startupBlockEnd)

    expect(startupBlock.indexOf('await actions.fetchSettings()')).toBeGreaterThanOrEqual(0)
    expect(startupBlock.indexOf('await actions.fetchSettings()')).toBeLessThan(
      startupBlock.indexOf('await actions.fetchRepos()')
    )
    expect(startupBlock.indexOf('await actions.fetchSettings()')).toBeLessThan(
      startupBlock.indexOf('await actions.fetchAllWorktrees()')
    )
  })
})
