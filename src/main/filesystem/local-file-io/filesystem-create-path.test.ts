import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createLocalFile } from './filesystem-create-path'

let root = ''
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('creates a new notebook as nbformat 4 JSON without clobbering an existing one', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-create-ipynb-'))
  const notebookPath = join(root, 'nested', 'Analysis.IPYNB')

  await createLocalFile(notebookPath)
  const created = JSON.parse(await readFile(notebookPath, 'utf8'))
  expect(created).toMatchObject({ nbformat: 4, cells: [{ cell_type: 'code', source: [] }] })

  await writeFile(notebookPath, 'user content')
  await expect(createLocalFile(notebookPath)).rejects.toThrow(
    "A file or folder named 'Analysis.IPYNB' already exists in this location"
  )
  expect(await readFile(notebookPath, 'utf8')).toBe('user content')
})
