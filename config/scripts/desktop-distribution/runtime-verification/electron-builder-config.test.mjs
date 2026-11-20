import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '../../..', '..')

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../../../electron-builder.config.cjs')
const { copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('electron-builder config', () => {
  // Bundled agent-browser answered "No skills found" because only its binary shipped (#17705).
  const hostBuilderPlatform = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]
  it.runIf(hostBuilderPlatform)(
    'ships the agent-browser skill catalog the packaged binary resolves',
    async () => {
      const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-agent-browser-'))
      try {
        const resources = electronBuilderConfig[hostBuilderPlatform].extraResources.filter(
          (entry) =>
            entry.from.startsWith('node_modules/agent-browser/') ||
            entry.from.startsWith('node_modules/@agent-browser/') ||
            entry.to === 'skills'
        )
        const expand = (value) => value.replace('${arch}', process.arch)
        await copyFiles(
          resources.map(
            (entry) =>
              new FileMatcher(
                join(REPO_ROOT, expand(entry.from)),
                join(resourcesDir, expand(entry.to)),
                (value) => value
              )
          )
        )
        const binary = resources.find((entry) => entry.to.startsWith('agent-browser-'))
        expect(binary).toBeDefined()
        const binaryPath = join(resourcesDir, expand(binary.to))
        // afterPack restores the executable bit; upstream tarball modes vary.
        await chmod(binaryPath, 0o755)
        const { AGENT_BROWSER_SKILLS_DIR: _override, ...env } = process.env
        const { stdout } = await promisify(execFile)(binaryPath, ['skills', 'get', 'core'], {
          env,
          windowsHide: true
        })
        expect(stdout).toContain('name: core')
      } finally {
        await rm(resourcesDir, { recursive: true, force: true })
      }
    }
  )
})
