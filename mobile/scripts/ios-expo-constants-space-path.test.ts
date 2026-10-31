import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const { quoteConstantsProjectDirectory } = require('../plugins/ios-expo-constants-space-path.js')

describe.skipIf(process.platform === 'win32')(
  'iOS Constants manifest with a spaced checkout path',
  () => {
    it('generates app.config after repairing the installed Expo script and remains idempotent', async () => {
      const root = await mkdtemp(join(tmpdir(), 'constants-'))
      try {
        const projectRoot = join(root, 'AI Workspace')
        const pods = join(projectRoot, 'ios', 'Pods')
        const scripts = join(root, 'expo-constants', 'scripts')
        const output = join(root, 'build')
        await mkdir(pods, { recursive: true })
        await mkdir(scripts, { recursive: true })
        await mkdir(join(output, 'EXConstants.bundle'), { recursive: true })
        const installed = join(
          dirname(require.resolve('expo-constants/package.json')),
          'scripts',
          'get-app-config-ios.sh'
        )
        const script = join(scripts, 'get-app-config-ios.sh')
        await writeFile(script, await readFile(installed, 'utf8'))
        await writeFile(
          join(scripts, 'with-node.sh'),
          '#!/usr/bin/env bash\nmkdir -p "$3"\nprintf manifest > "$3/app.config"\n',
          { mode: 0o755 }
        )
        const run = () =>
          spawnSync('bash', [script], {
            env: {
              ...process.env,
              PROJECT_DIR: pods,
              PROJECT_ROOT: projectRoot,
              CONFIGURATION_BUILD_DIR: output,
              BUNDLE_FORMAT: 'shallow'
            },
            encoding: 'utf8'
          })
        const manifest = join(output, 'EXConstants.bundle', 'app.config')
        const original = run()
        expect(original.error).toBeUndefined()
        expect(original.status).not.toBeNull()
        await expect(readFile(manifest, 'utf8')).rejects.toThrow()
        await quoteConstantsProjectDirectory(script)
        expect(run().status).toBe(0)
        expect(await readFile(manifest, 'utf8')).toBe('manifest')
        await quoteConstantsProjectDirectory(script)
        expect(run().status).toBe(0)
        expect(await readFile(manifest, 'utf8')).toBe('manifest')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
)
