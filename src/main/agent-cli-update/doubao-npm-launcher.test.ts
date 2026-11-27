import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { npmProgNodeShim } from '../../packages/process-host/src/__fixtures__/windows-cmd-shim-bodies'
import { isDoubaoNpmLauncher } from './doubao-npm-launcher'

it('recognizes the global npm entry behind a POSIX link, excluding local packages and native binaries', async () => {
  const program = '/opt/npm/bin/doubao'
  const entry = 'node_modules/@bytedance/doubao-cli/scripts/run.cjs'
  expect(await isDoubaoNpmLauncher(program, `/opt/npm/lib/${entry}`, 'linux')).toBe(true)
  expect(await isDoubaoNpmLauncher(program, `/project/${entry}`, 'linux')).toBe(false)
  expect(await isDoubaoNpmLauncher(program, '/opt/doubao/current/doubao', 'darwin')).toBe(false)
})

it('accepts the Windows npm shim only when it runs the public package in its own prefix', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'doubao npm-'))
  const shim = join(prefix, 'doubao.cmd')
  const entry = 'node_modules/@bytedance/doubao-cli/scripts/run.cjs'
  try {
    const officialShim = npmProgNodeShim(entry.replaceAll('/', '\\'))
    await writeFile(shim, officialShim)
    const realShim = await realpath(shim)
    expect(await isDoubaoNpmLauncher(shim, realShim, 'win32')).toBe(false)
    const scripts = dirname(join(prefix, entry))
    await mkdir(scripts, { recursive: true })
    await writeFile(join(prefix, entry), '')
    expect(await isDoubaoNpmLauncher(shim, realShim, 'win32')).toBe(true)
    await writeFile(shim, npmProgNodeShim('node_modules\\another-cli\\scripts\\run.cjs'))
    expect(await isDoubaoNpmLauncher(shim, realShim, 'win32')).toBe(false)
    await writeFile(shim, officialShim)
    const linkedScripts = join(prefix, 'other-scripts')
    await rename(scripts, linkedScripts)
    await symlink(linkedScripts, scripts, 'junction')
    expect(await isDoubaoNpmLauncher(shim, realShim, 'win32')).toBe(false)
  } finally {
    await rm(prefix, { recursive: true, force: true })
  }
})
