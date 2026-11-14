import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree } from '../../../../src/shared/windows-transient-lock-removal.ts'

const require = createRequire(import.meta.url)
const {
  prunePackagedNodePty,
  prunePackagedParcelWatcher,
  verifyPackagedMainRuntimeDeps
} = require('../../../packaged-runtime-node-modules.cjs')

describe('packaged runtime resources', () => {
  it('verifies literal dynamic imports from the packaged main bundle', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-dynamic-imports-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')

      // Cover shipped oxc memoized-import spelling and spaced equivalent.
      const sources = new Map([
        [
          'out/main/index.js',
          'let p=null;function q(){return p??=import(`@anthropic-ai/claude-agent-sdk`),p}'
        ],
        [
          'out/main/agent-hooks/installation/managed-agent-hook-controls.js',
          'import (`@anthropic-ai/claude-agent-sdk`)'
        ]
      ])
      const asar = {
        listPackage: () => [...sources.keys()].map((entry) => `/${entry}`),
        extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).toThrow(
        /@anthropic-ai\/claude-agent-sdk/
      )

      await mkdir(join(resourcesDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), {
        recursive: true
      })
      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('verifies bare imports that rolldown hoisted into a shared main chunk', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-chunk-imports-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')

      // The entry points themselves carry no specifier; only the shared chunk does.
      const sources = new Map([
        ['out/main/index.js', ''],
        ['out/main/agent-hooks/installation/managed-agent-hook-controls.js', ''],
        ['out/main/chunks/managed-agent-hook-controls-CWf8D-KR.js', 'require(`jsonc-parser`)']
      ])
      // listPackage includes directories that extractFile rejects; mock them to enforce the .js anchor.
      const directories = ['/out', '/out/main', '/out/main/chunks']
      const asar = {
        listPackage: () => [...directories, ...[...sources.keys()].map((entry) => `/${entry}`)],
        extractFile: (_asarPath, internalPath) => {
          const source = sources.get(internalPath)
          if (source === undefined) {
            throw new Error(`Expected to find file at: ${internalPath} but found a directory`)
          }
          return Buffer.from(source, 'utf8')
        }
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).toThrow(/jsonc-parser/)

      await mkdir(join(resourcesDir, 'node_modules', 'jsonc-parser'), { recursive: true })
      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('copies the Windows node-pty ConPTY runtime beside the rebuilt addon', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-node-pty-conpty-arm64-'))
    try {
      const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
      const releaseDir = join(nodePtyDir, 'build', 'Release')
      const conptyRoot = join(nodePtyDir, 'third_party', 'conpty', '0.1.0')
      await mkdir(releaseDir, { recursive: true })
      await writeFile(join(releaseDir, 'conpty.node'), 'native addon placeholder', 'utf8')
      for (const sourceArch of ['x64', 'arm64']) {
        const sourceDir = join(conptyRoot, `win10-${sourceArch}`)
        await mkdir(sourceDir, { recursive: true })
        await writeFile(join(sourceDir, 'conpty.dll'), `dll payload ${sourceArch}`, 'utf8')
        await writeFile(join(sourceDir, 'OpenConsole.exe'), `console payload ${sourceArch}`, 'utf8')
      }

      prunePackagedNodePty(resourcesDir, 'win32', 3)

      await expect(readFile(join(releaseDir, 'conpty', 'conpty.dll'), 'utf8')).resolves.toBe(
        'dll payload arm64'
      )
      await expect(readFile(join(releaseDir, 'conpty', 'OpenConsole.exe'), 'utf8')).resolves.toBe(
        'console payload arm64'
      )
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('leaves unrelated @parcel/* runtime deps untouched when pruning the watcher', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-parcel-watcher-prune-unrelated-'))
    try {
      const parcelDir = join(resourcesDir, 'node_modules', '@parcel')
      await mkdir(join(parcelDir, 'watcher'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-arm64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-x64-glibc'), { recursive: true })
      // A hypothetical future @parcel/* runtime dep that is NOT a watcher subpackage.
      await mkdir(join(parcelDir, 'transformer-js'), { recursive: true })

      prunePackagedParcelWatcher(resourcesDir, 'linux', 1)

      await expect(readdir(parcelDir).then((entries) => entries.sort())).resolves.toEqual([
        'transformer-js',
        'watcher',
        'watcher-linux-x64-glibc'
      ])
    } finally {
      await removeTree(resourcesDir)
    }
  })
})
