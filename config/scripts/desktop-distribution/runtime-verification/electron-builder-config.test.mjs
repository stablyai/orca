import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '../../..', '..')

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../../../electron-builder.config.cjs')
const { copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('electron-builder config', () => {
  it.each(['file', 'directory'])('keeps a root notes %s out of app.asar', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-packaging-notes-'))
    const source = join(root, 'app')
    const destination = join(root, 'selected')
    const runtimePaths = [
      'package.json',
      'out/main/index.js',
      'out/renderer/index.html',
      'out/cli/index.js',
      'out/shared/index.js',
      'out/main/notes/index.js',
      'out/renderer/assets/notes/help.md',
      'resources/notes/help.md',
      'notes.txt'
    ]
    const notesPaths =
      kind === 'file'
        ? ['notes']
        : [
            'notes/build.log',
            'notes/installed-orca-backup/Orca.exe',
            'notes/installed-orca-backup/resources/app.asar',
            'notes/orca-windows-setup.exe',
            'notes/.recovery/state.json'
          ]
    try {
      for (const fixturePath of [...runtimePaths, ...notesPaths]) {
        const file = join(source, fixturePath)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, 'synthetic fixture\n')
      }
      if (kind === 'directory') {
        await mkdir(join(source, 'notes', 'empty'))
      }
      const matcher = new FileMatcher(
        source,
        destination,
        (value) => value,
        electronBuilderConfig.files
      )
      // copyFiles adds the default include and prunes excluded directories during traversal.
      await copyFiles([matcher])
      for (const runtimePath of runtimePaths) {
        expect(await readFile(join(destination, runtimePath), 'utf8')).toBe('synthetic fixture\n')
      }
      const isPacked = matcher.createFilter()
      for (const notesPath of new Set(['notes', ...notesPaths])) {
        const file = join(source, notesPath)
        expect(isPacked(file, await lstat(file)), notesPath).toBe(false)
      }
      expect(existsSync(join(destination, 'notes'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Bundled agent-browser answered "No skills found" because only its binary shipped (#17705).
  const hostBuilderPlatform = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]
  it.runIf(hostBuilderPlatform)(
    'ships the agent-browser skill catalog the packaged binary resolves',
    async () => {
      const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-agent-browser-'))
      try {
        const resources = electronBuilderConfig[hostBuilderPlatform].extraResources.filter(
          (entry) => entry.from.startsWith('node_modules/agent-browser/') || entry.to === 'skills'
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
