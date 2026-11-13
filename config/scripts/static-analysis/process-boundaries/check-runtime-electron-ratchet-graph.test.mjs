import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectElectronImporters } from './check-runtime-electron-ratchet.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-electron-ratchet-graph-'))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, file)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, source)
  }
  return root
}

describe('the runtime Electron import graph', () => {
  it('finds Electron importers across CommonJS, conditional exports and dynamic imports', async () => {
    const root = fixture({
      'entry.mjs': `
        export { value } from './shared.cjs'
        export { value as imported } from 'conditional-package'
        export const load = () => import('./dynamic.mjs')
      `,
      'future.cjs': `
        module.exports = {
          value: require('conditional-package').value,
          addon: () => require('./missing.node'),
          desktop: () => require('desktop-package')
        }
      `,
      'shared.cjs': 'exports.value = 42',
      'dynamic.mjs': "import 'electron/renderer'; export const value = 1",
      'node_modules/conditional-package/package.json': JSON.stringify({
        exports: { '.': { import: './import.mjs', require: './require.cjs' } }
      }),
      'node_modules/conditional-package/import.mjs': "import 'electron'; export const value = 2",
      'node_modules/conditional-package/require.cjs': "require('electron/main'); exports.value = 3",
      'node_modules/desktop-package/package.json': '{"main":"index.cjs"}',
      'node_modules/desktop-package/index.cjs': "require('electron'); exports.value = 4"
    })
    const injectElectron = {
      name: 'inject-future-electron-import',
      setup(pluginBuild) {
        pluginBuild.onLoad({ filter: /future\.cjs$/ }, (args) => ({
          contents: `require('electron/utility')\n${readFileSync(args.path, 'utf8')}`,
          loader: 'js'
        }))
      }
    }
    const entries = ['entry.mjs', 'future.cjs', 'shared.cjs'].map((file) => path.join(root, file))
    const importers = await collectElectronImporters(entries, { plugins: [injectElectron] })

    expect(importers.map((file) => file.slice(file.indexOf(path.basename(root))))).toEqual([
      `${path.basename(root)}/dynamic.mjs`,
      `${path.basename(root)}/future.cjs`,
      `${path.basename(root)}/node_modules/conditional-package/import.mjs`,
      `${path.basename(root)}/node_modules/conditional-package/require.cjs`,
      `${path.basename(root)}/node_modules/desktop-package/index.cjs`
    ])
  })
})
