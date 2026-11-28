import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { buildUnixCliLauncher, buildWindowsDevLauncher } from './cli-dev-launcher'

const selectors = [
  'id:repo::/tmp/space path',
  'id:repo::/tmp/quotes" and smart“quotes”',
  'id:repo::/tmp/semi;&$`%!^()',
  'id:repo::/tmp/back\\slash/',
  'id:repo::/tmp/line\nfeed',
  'id:repo::/tmp/cafe\u0301',
  'id:repo::C:\\space path\\'
]

describe('workspace recovery data at the actual shell/launcher argv boundary', () => {
  it.skipIf(process.platform === 'win32')(
    'passes quoted data through the production POSIX launcher',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-choice-argv-'))
      try {
        const entry = join(root, 'argv.cjs')
        const launcher = join(root, 'orca')
        await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
        await writeFile(launcher, buildUnixCliLauncher(process.execPath, entry, root, 'node'), {
          mode: 0o755
        })
        for (const selector of selectors) {
          const result = await runProcess({
            program: '/bin/sh',
            args: [
              '-c',
              'exec "$1" worktree show --worktree "$2" --json',
              'choice-fixture',
              launcher,
              selector
            ]
          })
          expect(result.code, result.stderr).toBe(0)
          expect(JSON.parse(result.stdout)).toEqual([
            'worktree',
            'show',
            '--worktree',
            selector,
            '--json'
          ])
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
  it.skipIf(process.platform !== 'win32')(
    'passes data through the production development cmd launcher within its no-line-break domain',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-choice-cmd-'))
      try {
        const entry = join(root, 'argv.cjs')
        const launcher = join(root, 'orca.cmd')
        await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
        await writeFile(launcher, buildWindowsDevLauncher(process.execPath, entry, root))
        for (const selector of selectors.filter((value) => !value.includes('\n'))) {
          const result = await runProcess({
            program: launcher,
            args: ['worktree', 'show', '--worktree', selector, '--json']
          })
          expect(result.code, result.stderr).toBe(0)
          expect(JSON.parse(result.stdout)).toEqual([
            'worktree',
            'show',
            '--worktree',
            selector,
            '--json'
          ])
        }
        await expect(
          runProcess({
            program: launcher,
            args: ['worktree', 'show', '--worktree', selectors[4]!, '--json']
          })
        ).rejects.toThrow(/line break/)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
