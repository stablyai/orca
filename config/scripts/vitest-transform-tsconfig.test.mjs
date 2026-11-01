import { globSync, readFileSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const references = (file) =>
  JSON.parse(readFileSync(resolve(root, file), 'utf8')).references.map(({ path }) =>
    posix.join(posix.dirname(file), path)
  )

// Unit tests transform with this pinned solution, so a project missing from it loses its compiler options.
it('lists every project tsconfig auto-discovery would find for unit-test sources', () => {
  const nested = globSync('**/tsconfig.json', {
    cwd: root,
    exclude: ['**/node_modules/**', 'mobile/**', 'docs/**']
  })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => dirname(file) !== '.')
  expect(references('config/tsconfig.vitest-transform.json').sort()).toEqual(
    [...nested, ...references('tsconfig.json')].sort()
  )
})
