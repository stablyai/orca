import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'

it.each(['renderer', 'web'])(
  'isolates %s optimized dependencies without overriding source tsconfigs',
  async (client) => {
    const gitDirectory = await runProcess({
      program: 'git',
      args: ['rev-parse', '--absolute-git-dir']
    })
    expect(gitDirectory.code, gitDirectory.stderr).toBe(0)
    for (const boundary of ['absent', 'empty', 'present']) {
      const parent = await mkdtemp(join(tmpdir(), 'orca-vite-tsconfig-'))
      const worktree = join(parent, 'child')
      const source = join(worktree, 'src', 'renderer', 'src')
      try {
        await mkdir(join(source, 'nested'), { recursive: true })
        await mkdir(join(worktree, 'config'))
        await writeFile(
          join(parent, 'tsconfig.json'),
          JSON.stringify({ extends: '@missing-parent-checkout/tsconfig' })
        )
        await writeFile(join(worktree, 'package.json'), JSON.stringify({ type: 'module' }))
        await writeFile(
          join(worktree, 'tsconfig.json'),
          JSON.stringify({ files: [], references: [{ path: './config/tsconfig.web.json' }] })
        )
        await writeFile(
          join(worktree, 'config', 'tsconfig.web.json'),
          JSON.stringify({
            include: ['../src/renderer/src/**/*'],
            compilerOptions: { useDefineForClassFields: false, jsx: 'react-jsx' }
          })
        )
        await writeFile(
          join(source, 'nested', 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { useDefineForClassFields: true } })
        )
        await writeFile(join(source, 'entry.tsx'), 'export const entry = <div />')
        for (const directory of [source, join(source, 'nested')]) {
          await writeFile(join(directory, 'fields.ts'), 'export class Fields { value = 1 }')
        }
        await symlink(resolve('node_modules'), join(worktree, 'node_modules'), 'junction')
        const result = await runProcess({
          program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
          args: [
            resolve('config/scripts/fixtures/vite-cache-tsconfig-discovery.mjs'),
            process.cwd(),
            client,
            boundary
          ],
          cwd: worktree,
          env: {
            ...process.env,
            ORCA_BACKGROUND_LAUNCH: '1',
            ORCA_DEV_BUNDLED: '0',
            GIT_DIR: gitDirectory.stdout.trim()
          },
          timeoutMs: 20_000,
          terminationBarrier: true
        })
        expect(result.code, result.stderr).toBe(0)
        if (boundary !== 'present') {
          expect(JSON.parse(result.stdout)).toEqual({ client, parentConfigRejected: true })
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            client,
            cachedDependency: true,
            sourceConfig: true,
            nestedConfig: true
          })
        }
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    }
  }
)
