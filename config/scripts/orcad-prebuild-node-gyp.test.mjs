import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nodeGypRebuild } from './orcad-prebuild-node-gyp.mjs'

let directory
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orcad-node-gyp-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

function compile(runProcess) {
  return nodeGypRebuild({
    stagedDir: directory,
    workDir: directory,
    nodeDir: 'pinned-headers',
    runProcess
  })
}

it('preserves an explicitly selected Windows compiler in the child environment', async () => {
  const environment = { PATH: 'selected-path', VCINSTALLDIR: 'selected', TOKEN: 'preserved' }
  vi.stubGlobal('process', { ...process, platform: 'win32', env: environment })
  const run = vi.fn(() => ({ code: 0 }))
  expect(await compile(run)).toBe(join(directory, 'build', 'Release'))
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      env: environment,
      args: expect.arrayContaining(['rebuild', '--nodedir=pinned-headers']),
      cwd: directory,
      stdio: 'inherit'
    })
  )
  expect(environment).toEqual({
    PATH: 'selected-path',
    VCINSTALLDIR: 'selected',
    TOKEN: 'preserved'
  })
})

it('keeps the current environment and writes the compile policy on other hosts', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  const run = vi.fn(() => ({ code: 0 }))
  await compile(run)
  expect(run.mock.calls[0][0].env).toBe(process.env)
  expect(run.mock.calls[0][0].args).toContain(join(directory, 'prebuild-compile.gypi'))
  expect(readFileSync(join(directory, 'prebuild-compile.gypi'), 'utf8')).toContain('NAPI_VERSION')
})

it('propagates compiler failures', async () => {
  await expect(compile(() => ({ code: 9 }))).rejects.toThrow('status 9')
})
