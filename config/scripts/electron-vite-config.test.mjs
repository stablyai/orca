import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('electron-vite config', () => {
  it('keeps CLI out/main runtime imports available after main rebuilds', async () => {
    const source = await readFile(resolve('electron.vite.config.ts'), 'utf8')

    expect(source).toContain("'agent-hooks/managed-agent-hook-controls'")
    expect(source).toContain("'scryer/engine/index'")
    expect(source).toContain("'src/main/scryer/engine/index.ts'")
  })
})
