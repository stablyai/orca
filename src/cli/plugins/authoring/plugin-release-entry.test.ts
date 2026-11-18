import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'
import { validatePluginTarget } from './plugin-folder-validation'
import { pluginReleaseEntryForFolder } from './plugin-release-entry'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-release-entry-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args: [
      ...['user.name=Orca Test', 'user.email=test@example.com', 'commit.gpgsign=false'].flatMap(
        (setting) => ['-c', setting]
      ),
      ...args
    ],
    cwd
  })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim()
}

async function releaseFor(dir: string) {
  return pluginReleaseEntryForFolder(await validatePluginTarget(dir))
}

describe('orca plugin release-entry', () => {
  it('resolves the HEAD entry and source path for a plugin in a subdirectory', async () => {
    const repo = await tempRoot()
    await git(repo, ['init', '--quiet'])
    const dir = join(repo, 'plugins', 'dusk')
    await createPluginFromTemplate({ dir, template: 'theme', publisher: 'acme' })
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '--quiet', '-m', 'add dusk'])

    const result = await releaseFor(dir)
    expect(result.sourcePath).toBe('plugins/dusk')
    expect(result.note).toBeUndefined()
    expect(result.entry).toMatchObject({
      commit: await git(repo, ['rev-parse', 'HEAD'])
    })
  })

  it('gives no entry when the commit lacks a file the manifest declares', async () => {
    const repo = await tempRoot()
    await git(repo, ['init', '--quiet'])
    await createPluginFromTemplate({ dir: repo, template: 'theme', publisher: 'acme' })
    await git(repo, ['add', 'orca-plugin.json'])
    await git(repo, ['commit', '--quiet', '-m', 'manifest only'])

    const result = await releaseFor(repo)
    expect(result.entry).toBeUndefined()
    expect(result.note).toContain('themes/dark.json')
  })
})
