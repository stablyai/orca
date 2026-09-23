import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const root = process.argv[2]
assert.match(root, /^\/tmp\/orca-cow-rpc\.[A-Za-z0-9]+$/)
const source = join(root, 'source')
const target = join(root, 'target')
mkdirSync(source)
const git = (args) => execFileSync('git', args, { cwd: source, stdio: 'pipe' })
git(['init', '-q'])
writeFileSync(join(source, '.gitignore'), '.env\ndeps/\ncache/\n')
writeFileSync(join(source, '.worktreeinclude'), '.env\ncache\n')
writeFileSync(join(source, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - deps\n')
git(['add', '.'])
git([
  '-c',
  'user.name=CoW test',
  '-c',
  'user.email=cow@example.invalid',
  'commit',
  '-qm',
  'fixture'
])
git(['worktree', 'add', '-qb', 'feature', target])
writeFileSync(join(source, '.env'), 'original')
mkdirSync(join(source, 'deps'))
writeFileSync(join(source, 'deps', 'value'), 'shared')
mkdirSync(join(source, 'cache'))
writeFileSync(join(source, 'cache', 'value'), 'original alias')
symlinkSync('value', join(source, 'cache', 'alias'))
