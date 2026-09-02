import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  collectRuntimeClosure,
  runCli,
  verifySkillsCliRuntime
} = require('./verify-skills-cli-runtime.cjs')

async function writeSkillsCliFixture(outDir, handlerSource) {
  const cliDir = join(outDir, 'cli')
  const handlerDir = join(cliDir, 'handlers')
  await mkdir(handlerDir, { recursive: true })
  await writeFile(join(cliDir, 'index.js'), "require('./handlers/skills')\n", 'utf8')
  await writeFile(join(handlerDir, 'skills.js'), handlerSource, 'utf8')
}

describe('skills CLI runtime closure', () => {
  it('runs after Electron composes the final output', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    )
    for (const scriptName of ['build:desktop', 'build:release']) {
      const script = packageJson.scripts[scriptName]
      expect(script.indexOf('build:electron-vite')).toBeLessThan(
        script.indexOf('verify:built-skills-cli')
      )
    }
  })

  it('reports the missing final-artifact import and its owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      await writeSkillsCliFixture(root, "require('../../main/codex-cli/command')\n")

      expect(() => collectRuntimeClosure(root)).toThrow(
        /missing runtime import "\.\.\/\.\.\/main\/codex-cli\/command" from cli\/handlers\/skills\.js/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('walks static and dynamic relative imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      const sharedDir = join(root, 'shared')
      await mkdir(sharedDir, { recursive: true })
      await writeSkillsCliFixture(
        root,
        "require('../../shared/first.js'); import('../../shared/second.js')\n"
      )
      await writeFile(join(sharedDir, 'first.js'), '', 'utf8')
      await writeFile(join(sharedDir, 'second.js'), '', 'utf8')

      expect(
        collectRuntimeClosure(root)
          .map((file) => relative(realpathSync(root), file))
          .sort()
      ).toEqual(['cli/handlers/skills.js', 'cli/index.js', 'shared/first.js', 'shared/second.js'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores import-shaped text in comments and strings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      await writeSkillsCliFixture(
        root,
        [
          "// require('../../missing-comment.js')",
          'const message = "import(\'../../missing-string.js\')"',
          "const template = `require.resolve('../../missing-template.js')`"
        ].join('\n')
      )

      expect(collectRuntimeClosure(root)).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('can inspect a cross-arch artifact without executing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      await writeSkillsCliFixture(root, '')

      expect(verifySkillsCliRuntime(root, undefined, { executeCommands: false })).toEqual({
        closureFiles: 2,
        commands: 0
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds command execution time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      await writeSkillsCliFixture(root, 'setInterval(() => {}, 1_000)\n')

      expect(() => runCli(root, [], 50)).toThrow(/ETIMEDOUT|terminated by SIGKILL/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects bare imports resolved outside the artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      const artifactRoot = join(root, 'artifact')
      const outDir = join(artifactRoot, 'out')
      const externalPackageDir = join(root, 'node_modules', 'external-package')
      await mkdir(externalPackageDir, { recursive: true })
      await writeSkillsCliFixture(outDir, "require('external-package')\n")
      await writeFile(
        join(externalPackageDir, 'package.json'),
        JSON.stringify({ main: 'index.js' }),
        'utf8'
      )
      await writeFile(join(externalPackageDir, 'index.js'), '', 'utf8')

      expect(() => collectRuntimeClosure(outDir, artifactRoot)).toThrow(
        /external-package.*resolved outside/s
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects package dependencies resolved outside the artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      const artifactRoot = join(root, 'artifact')
      const outDir = join(artifactRoot, 'out')
      const packageDir = join(artifactRoot, 'node_modules', 'inside-package')
      const externalPackageDir = join(root, 'node_modules', 'ancestor-dependency')
      await writeSkillsCliFixture(outDir, "require('inside-package')\n")
      await mkdir(packageDir, { recursive: true })
      await mkdir(externalPackageDir, { recursive: true })
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({ main: 'index.js' }),
        'utf8'
      )
      await writeFile(join(packageDir, 'index.js'), "require('ancestor-dependency')\n", 'utf8')
      await writeFile(
        join(externalPackageDir, 'package.json'),
        JSON.stringify({ main: 'index.js' }),
        'utf8'
      )
      await writeFile(join(externalPackageDir, 'index.js'), '', 'utf8')

      expect(() => collectRuntimeClosure(outDir, artifactRoot)).toThrow(
        /ancestor-dependency.*resolved outside/s
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows absent dependencies declared optional by their package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      const artifactRoot = join(root, 'artifact')
      const outDir = join(artifactRoot, 'out')
      const packageDir = join(artifactRoot, 'node_modules', 'inside-package')
      await writeSkillsCliFixture(outDir, "require('inside-package')\n")
      await mkdir(packageDir, { recursive: true })
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          main: 'index.js',
          peerDependencies: { 'optional-native': '*' },
          peerDependenciesMeta: { 'optional-native': { optional: true } }
        }),
        'utf8'
      )
      await writeFile(
        join(packageDir, 'index.js'),
        "try { require('optional-native') } catch {}\n",
        'utf8'
      )

      expect(collectRuntimeClosure(outDir, artifactRoot)).toHaveLength(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects optional dependencies resolved only outside the artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      const artifactRoot = join(root, 'artifact')
      const outDir = join(artifactRoot, 'out')
      const packageDir = join(artifactRoot, 'node_modules', 'inside-package')
      const externalPackageDir = join(root, 'node_modules', 'optional-native')
      await writeSkillsCliFixture(outDir, "require('inside-package')\n")
      await mkdir(packageDir, { recursive: true })
      await mkdir(externalPackageDir, { recursive: true })
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          main: 'index.js',
          optionalDependencies: { 'optional-native': '*' }
        }),
        'utf8'
      )
      await writeFile(join(packageDir, 'index.js'), "require('optional-native')\n", 'utf8')
      await writeFile(
        join(externalPackageDir, 'package.json'),
        JSON.stringify({ main: 'index.js' }),
        'utf8'
      )
      await writeFile(join(externalPackageDir, 'index.js'), '', 'utf8')

      expect(() => collectRuntimeClosure(outDir, artifactRoot)).toThrow(
        /optional-native.*resolved outside/s
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
