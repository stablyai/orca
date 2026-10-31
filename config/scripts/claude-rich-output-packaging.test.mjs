import { runProcessSync } from '@orca/process-host'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const config = require('../electron-builder.config.cjs')
const { copyFiles, getFileMatchers } = require('app-builder-lib/out/fileMatcher')

it.each(['mac', 'linux', 'win'])(
  'loads rich-output dependencies after the %s extraResources copy',
  async (platform) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-rich-package-'))
    try {
      const source = join(root, 'project')
      const resources = join(root, 'installed', 'resources')
      const put = async (name, text) => {
        const file = join(source, 'out', 'claude-rich-output', name)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text)
      }
      for (const [name, token] of [
        ['beautiful-mermaid', 'mermaid'],
        ['@mathjax/src', 'mathjax']
      ]) {
        await put(
          `node_modules/${name}/package.json`,
          JSON.stringify({ type: 'module', exports: './index.js' })
        )
        await put(`node_modules/${name}/index.js`, `export const token = '${token}'`)
      }
      await put(
        'probe.mjs',
        "import { token as diagram } from 'beautiful-mermaid';\n" +
          "import { token as math } from '@mathjax/src';\n" +
          "process.stdout.write([diagram, math].join('|'))"
      )
      const extraResources = config[platform].extraResources.filter((entry) =>
        entry.from?.startsWith('out/claude-rich-output')
      )
      await copyFiles(
        getFileMatchers({ extraResources }, 'extraResources', resources, {
          defaultSrc: source,
          globalOutDir: join(source, 'dist'),
          macroExpander: (value) => value,
          customBuildOptions: {}
        })
      )
      const result = runProcessSync({
        program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
        args: [join(resources, 'claude-rich-output', 'probe.mjs')],
        cwd: resources,
        env: { ...process.env, NODE_PATH: '' },
        timeoutMs: 30_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('mermaid|mathjax')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
