import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'
import { resolveTsrsTypecheckCommand, supportsTsrs } from './tsrs-typecheck-compiler.mjs'

it('isolates cache files by project, worktree and compiler version', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-tsrs-paths-'))
  try {
    const manifest = join(root, 'node_modules', 'tsrs', 'package.json')
    mkdirSync(dirname(manifest), { recursive: true })
    const install = (version) =>
      writeFileSync(manifest, JSON.stringify({ version, bin: { tsrs: 'bin/tsrs' } }))
    install('0.18.0')
    const cache = (config, directory = root) => {
      const command = resolveTsrsTypecheckCommand(config, directory)
      return command.args[command.args.indexOf('--tsBuildInfoFile') + 1]
    }
    const first = cache('a/tsconfig.json')
    expect(cache('a/tsconfig.json')).toBe(first)
    expect(cache('b/tsconfig.json')).not.toBe(first)
    install('0.19.0')
    expect(cache('a/tsconfig.json')).not.toBe(first)
    const other = join(root, 'other-worktree')
    mkdirSync(other)
    symlinkSync(join(root, 'node_modules'), join(other, 'node_modules'), 'junction')
    expect(cache('a/tsconfig.json', other)).not.toBe(cache('a/tsconfig.json'))
    expect(existsSync(dirname(first))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('explains how to install a missing local compiler', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-tsrs-missing-'))
  try {
    const module = pathToFileURL(resolve('config/scripts/tsrs-typecheck-compiler.mjs')).href
    const result = runProcessSync({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `import { resolveTsrsTypecheckCommand } from ${JSON.stringify(module)}; resolveTsrsTypecheckCommand('tsconfig.json', process.argv[1])`,
        root
      ],
      cwd: root,
      timeoutMs: 10_000
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('run pnpm install')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(!supportsTsrs())(
  'reuses a real cache and invalidates exported types, deleted files and config changes',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-tsrs-incremental-'))
    try {
      symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction')
      writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}')
      const config = join(root, 'tsconfig.json')
      const writeConfig = (strictNullChecks) =>
        writeFileSync(
          config,
          JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'Node16',
              moduleResolution: 'Node16',
              strict: true,
              strictNullChecks,
              skipLibCheck: true,
              types: []
            },
            include: ['*.ts']
          })
        )
      writeConfig(true)
      const model = join(root, 'model.ts')
      writeFileSync(model, 'export interface Model { value: number }\n')
      writeFileSync(
        join(root, 'consumer.ts'),
        "import type { Model } from './model'\nexport const model: Model = { value: 1 }\n"
      )
      const command = resolveTsrsTypecheckCommand('tsconfig.json', root)
      const check = () =>
        runProcessSync({
          ...command,
          args: [...command.args, '--pretty', 'false'],
          timeoutMs: 30_000,
          env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
        })
      expect(check().code).toBe(0)
      const cache = command.args[command.args.indexOf('--tsBuildInfoFile') + 1]
      expect(existsSync(cache)).toBe(true)
      const saved = readFileSync(cache, 'utf8')
      expect(check().code).toBe(0)
      expect(readFileSync(cache, 'utf8')).toBe(saved)

      writeFileSync(model, 'export interface Model { value: string }\n')
      const broken = check()
      expect(broken.code).not.toBe(0)
      expect(broken.stdout + broken.stderr).toContain('TS2322')
      writeFileSync(model, 'export interface Model { value: number }\n')
      expect(check().code).toBe(0)

      writeFileSync(join(root, 'deleted.ts'), 'export const invalid: number = "reject"\n')
      expect(check().code).not.toBe(0)
      rmSync(join(root, 'deleted.ts'))
      expect(check().code).toBe(0)

      writeFileSync(join(root, 'nullable.ts'), 'export const nullable: string = null\n')
      expect(check().code).not.toBe(0)
      writeConfig(false)
      expect(check().code).toBe(0)
      writeConfig(true)
      expect(check().code).not.toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  60_000
)
