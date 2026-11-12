import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(new URL('../../verify-skills-cli-runtime.test.mjs', import.meta.url))
const {
  collectRuntimeClosure
} = require('./runtime-verification/skills-cli/verify-skills-cli-runtime.cjs')

async function writeSkillsCliFixture(outDir, handlerSource) {
  const cliDir = join(outDir, 'cli')
  const handlerDir = join(cliDir, 'handlers')
  await mkdir(handlerDir, { recursive: true })
  await writeFile(join(cliDir, 'index.js'), "require('./handlers/skills')\n", 'utf8')
  await writeFile(join(handlerDir, 'skills.js'), handlerSource, 'utf8')
}

describe('skills CLI runtime closure', () => {
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

  it("resolves a linked package's imports from its store slot, as Node does", async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-cli-closure-'))
    try {
      const artifactRoot = join(root, 'artifact')
      const outDir = join(artifactRoot, 'out')
      const slotDir = join(root, 'store', 'linked-package')
      await writeSkillsCliFixture(outDir, "require('linked-package')\n")
      await mkdir(slotDir, { recursive: true })
      await writeFile(join(slotDir, 'package.json'), JSON.stringify({ main: 'index.js' }), 'utf8')
      await writeFile(join(slotDir, 'index.js'), "require('dep')\n", 'utf8')
      // Node reaches the ancestor copy (like ~/node_modules) from the slot, not the artifact's own.
      for (const dir of [
        join(root, 'node_modules', 'dep'),
        join(artifactRoot, 'node_modules', 'dep')
      ]) {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'index.js'), '', 'utf8')
      }
      await symlink(slotDir, join(artifactRoot, 'node_modules', 'linked-package'), 'junction')

      expect(() => collectRuntimeClosure(outDir, artifactRoot)).toThrow(/resolved outside/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
