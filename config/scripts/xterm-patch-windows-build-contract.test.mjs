import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  adaptAddonBuildCommandsForWindows,
  resetCheckoutSource
} from './regenerate-xterm-patches.mjs'
import { createPatchTestDirectory } from './xterm-patch-test-files.mjs'

describe('Windows terminal patch builds', () => {
  it('uses npm command lookup for Windows addon builds without changing other scripts', async () => {
    const root = await createPatchTestDirectory()
    const file = path.join(root, 'package.json')
    const metadata = {
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        build: '../../node_modules/.bin/tsgo -p .',
        prepackage: 'npm run build',
        package: '../../node_modules/.bin/webpack',
        start: 'node ../../demo/start'
      }
    }
    const original = JSON.stringify(metadata)
    await writeFile(file, original)
    for (const platform of ['darwin', 'linux']) {
      adaptAddonBuildCommandsForWindows(root, platform)
      expect(await readFile(file, 'utf8')).toBe(original)
    }
    adaptAddonBuildCommandsForWindows(root, 'win32')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      ...metadata,
      scripts: { ...metadata.scripts, build: 'tsgo -p .', package: 'webpack' }
    })
    metadata.scripts.prepackage = '../../node_modules/.bin/tsgo -p .'
    await writeFile(file, JSON.stringify(metadata))
    adaptAddonBuildCommandsForWindows(root, 'win32')
    expect(JSON.parse(await readFile(file, 'utf8')).scripts.prepackage).toBe('tsgo -p .')
  })

  it('restores registry line endings despite the host Git configuration', async () => {
    const root = await createPatchTestDirectory()
    await mkdir(path.join(root, 'src'))
    const file = path.join(root, 'src', 'Tracked.ts')
    await writeFile(file, 'export const value = 1;\n')
    await writeFile(path.join(root, '.gitattributes'), '* text=auto\n')
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git(['init', '--quiet'])
    git(['config', 'core.autocrlf', 'true'])
    git(['config', 'core.eol', 'crlf'])
    git(['add', 'src/', '.gitattributes'])
    git([
      '-c',
      'user.name=Image test',
      '-c',
      'user.email=image-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    ])
    const commit = git(['rev-parse', 'HEAD']).trim()
    await rm(file)
    git(['checkout-index', '--all', '--force'])
    expect(await readFile(file, 'utf8')).toContain('\r\n')
    resetCheckoutSource(root, commit)
    expect(await readFile(file, 'utf8')).toBe('export const value = 1;\n')
    expect(git(['config', '--get', 'core.autocrlf']).trim()).toBe('true')
  })
})
