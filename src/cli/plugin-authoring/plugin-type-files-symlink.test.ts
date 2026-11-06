import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'

const TSC = resolve(__dirname, '../../../node_modules/typescript/bin/tsc')
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('orca plugin types under a symlinked folder', () => {
  // macOS /tmp is a symlink to /private/tmp; tsc 7 loaded the typings via both paths (TS2300).
  it('typechecks a scaffolded components plugin reached through a symlink', async () => {
    const real = await mkdtemp(join(await realpath(tmpdir()), 'orca-plugin-types-real-'))
    const link = `${real}-link`
    cleanup.push(link, real)
    await symlink(real, link, 'dir')
    const pluginDir = join(link, 'panel')
    await createPluginFromTemplate({ dir: pluginDir, template: 'components' })
    const result = await runProcess({
      program: process.execPath,
      args: [TSC, '-p', pluginDir],
      cwd: pluginDir,
      env: { ...process.env, PWD: pluginDir },
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0)
  }, 90_000)
})
