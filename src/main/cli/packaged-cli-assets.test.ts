import { execFile } from 'node:child_process'
import { copyFile, chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const itRunsUnixShell = process.platform === 'win32' ? it.skip : it
const builderConfig = require('../../../config/electron-builder.config.cjs') as {
  asarUnpack?: string[]
}
const linuxLauncherAsset = new URL('../../../resources/linux/bin/orca-ide', import.meta.url)

describe('packaged CLI assets', () => {
  it('unpacks runtime dependencies used before Electron asar integration is available', () => {
    expect(builderConfig.asarUnpack).toEqual(
      expect.arrayContaining([
        'node_modules/ws/**',
        'node_modules/tweetnacl/**',
        'node_modules/zod/**',
        'node_modules/yaml/**'
      ])
    )
  })

  itRunsUnixShell('keeps the Linux launcher executable in packaged resources', async () => {
    const launcherStats = await stat(linuxLauncherAsset)
    expect(launcherStats.mode & 0o111).not.toBe(0)
  })

  itRunsUnixShell(
    'runs the Linux launcher from its packaged path and installed symlink',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-linux-cli-'))
      try {
        const appDir = join(root, 'Orca')
        const resourcesDir = join(appDir, 'resources')
        const launcherDir = join(resourcesDir, 'bin')
        const cliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
        const launcherPath = join(launcherDir, 'orca-ide')
        const electronPath = join(appDir, 'orca-ide')
        const cliPath = join(cliDir, 'index.js')

        await mkdir(launcherDir, { recursive: true })
        await mkdir(cliDir, { recursive: true })
        await copyFile(linuxLauncherAsset, launcherPath)
        await chmod(launcherPath, 0o755)
        await writeFile(cliPath, '', 'utf8')
        await writeFile(
          electronPath,
          `#!/usr/bin/env bash
printf 'electron=%s\\n' "$0"
printf 'run_as_node=%s\\n' "\${ELECTRON_RUN_AS_NODE-}"
printf 'arg=%s\\n' "$@"
`,
          { encoding: 'utf8', mode: 0o755 }
        )

        const direct = await execFileAsync(launcherPath, ['--help'])
        expect(direct.stdout).toContain(`electron=${electronPath}`)
        expect(direct.stdout).toContain('run_as_node=1')
        expect(direct.stdout).toContain(`arg=${cliPath}`)
        expect(direct.stdout).toContain('arg=--help')

        const homeDir = join(root, 'home')
        const commandDir = join(homeDir, '.local', 'bin')
        const commandPath = join(commandDir, 'orca-ide')
        await mkdir(commandDir, { recursive: true })
        await mkdir(join(homeDir, 'orca'), { recursive: true })
        await symlink(launcherPath, commandPath)

        const symlinked = await execFileAsync(commandPath, ['--help'], {
          env: { ...process.env, HOME: homeDir }
        })
        expect(symlinked.stdout).toContain(`electron=${electronPath}`)
        expect(symlinked.stdout).toContain('run_as_node=1')
        expect(symlinked.stdout).toContain(`arg=${cliPath}`)
        expect(symlinked.stdout).toContain('arg=--help')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
