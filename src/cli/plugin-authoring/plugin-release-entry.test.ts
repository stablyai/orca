import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { hashPluginTree } from '../../main/plugins/plugin-authoring-checks'
import { createPluginFromTemplate } from './plugin-create'
import { validatePluginTarget } from './plugin-folder-validation'
import { formatPluginReleaseEntry, pluginReleaseEntryForFolder } from './plugin-release-entry'

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
  it('prints the HEAD entry and source path for a plugin in a subdirectory', async () => {
    const repo = await tempRoot()
    await git(repo, ['init', '--quiet'])
    const dir = join(repo, 'plugins', 'dusk')
    await createPluginFromTemplate({ dir, template: 'theme', publisher: 'acme' })
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '--quiet', '-m', 'add dusk'])

    const result = await releaseFor(dir)
    const hashed = await hashPluginTree(dir)
    expect(hashed.ok).toBe(true)
    expect(result.sourcePath).toBe('plugins/dusk')
    expect(result.note).toBeUndefined()
    expect(result.entry).toMatchObject({
      version: '0.1.0',
      commit: await git(repo, ['rev-parse', 'HEAD']),
      contentHash: hashed.ok ? hashed.hash : '',
      execution: 'data'
    })
    const text = formatPluginReleaseEntry(result)
    expect(text).toContain('"path" in this plugin\'s "source"): "plugins/dusk"')
    expect(text).toContain(`"commit": "${result.entry?.commit}"`)
  })

  it('pins the committed files, not uncommitted edits', async () => {
    const repo = await tempRoot()
    await git(repo, ['init', '--quiet'])
    await createPluginFromTemplate({ dir: repo, template: 'theme', publisher: 'acme' })
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '--quiet', '-m', 'init'])
    const committed = await releaseFor(repo)
    await writeFile(join(repo, 'NOTES.txt'), 'draft')

    const result = await releaseFor(repo)
    expect(result.sourcePath).toBeUndefined()
    expect(result.entry?.contentHash).toBe(committed.entry?.contentHash)
    expect(result.note).toContain('uncommitted changes')
  })

  it('explains why there is no entry outside Git or before the first commit', async () => {
    const outside = join(await tempRoot(), 'loose')
    await createPluginFromTemplate({ dir: outside, template: 'theme', publisher: 'acme' })
    expect((await releaseFor(outside)).note).toContain('not in a Git repository')

    const repo = await tempRoot()
    await git(repo, ['init', '--quiet'])
    await mkdir(join(repo, 'p'))
    await createPluginFromTemplate({ dir: join(repo, 'p'), template: 'theme', publisher: 'acme' })
    const uncommitted = await releaseFor(join(repo, 'p'))
    expect(uncommitted.entry).toBeUndefined()
    expect(uncommitted.note).toContain('commit the plugin first')
  })
})
