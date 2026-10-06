import { expect, it } from 'vitest'
import { access } from 'node:fs/promises'
import { runProcessSync } from '../../src/shared/child-process/run-process'

it('uses Bun for ordinary suites when the Bun project is selected', () => {
  expect(Boolean(process.versions.bun)).toBe(process.env.ORCA_VITEST_RUNTIME === 'bun')
})

it('preserves Node access() success and missing-file rejection', async () => {
  await expect(access(import.meta.filename)).resolves.toBeUndefined()
  await expect(access(`${import.meta.filename}.missing`)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('launches application child fixtures under Node even when Vitest runs under Bun', () => {
  const result = runProcessSync({
    program: process.execPath,
    args: ['-p', 'JSON.stringify({node:process.versions.node,bun:process.versions.bun})']
  })
  expect(result.code).toBe(0)
  const identity: unknown = JSON.parse(result.stdout)
  expect(identity).toEqual({ node: expect.stringMatching(/^\d+\.\d+\.\d+$/) })
})
