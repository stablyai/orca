import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { rgPath } from '@vscode/ripgrep-universal'
import { configureRelayBundledRipgrep } from './relay-bundled-ripgrep'
import { searchWithRg } from './fs-handler-utils'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-search-errors-'))
  configureRelayBundledRipgrep(rgPath)
  await writeFile(join(root, 'source.txt'), 'needle\n')
})
afterEach(async () => {
  configureRelayBundledRipgrep(undefined)
  await rm(root, { recursive: true, force: true })
})

it('reports an invalid regular expression as an error', async () => {
  await expect(searchWithRg(root, '[', { useRegex: true, maxResults: 100 })).rejects.toThrow(
    /regex parse error|unclosed character class/
  )
})

it('distinguishes no matches from invalid syntax', async () => {
  await expect(searchWithRg(root, 'absent', { maxResults: 100 })).resolves.toEqual({
    files: [],
    totalMatches: 0,
    truncated: false
  })
})

it('retains intentional capped results after stopping the process', async () => {
  await writeFile(join(root, 'source.txt'), 'needle\n'.repeat(1000))
  const result = await searchWithRg(root, 'needle', { maxResults: 2 })
  expect(result.totalMatches).toBe(2)
  expect(result.truncated).toBe(true)
})
