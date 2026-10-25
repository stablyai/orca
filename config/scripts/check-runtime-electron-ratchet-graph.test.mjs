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

async function inspectGraph(entries, { separateEntries = false, plugins = [] } = {}) {
  let result
  const inspect = {
    name: 'inspect-electron-ratchet-graph',
    setup(pluginBuild) {
      if (separateEntries) {
        delete pluginBuild.initialOptions.stdin
        pluginBuild.initialOptions.entryPoints = entries
      }
      pluginBuild.onEnd((built) => {
        result = built
      })
    }
  }
  const importers = await collectElectronImporters(entries, { plugins: [...plugins, inspect] })
  return { importers, ...result }
}

function fixtureInputs(result, root) {
  return Object.fromEntries(
    Object.entries(result.metafile.inputs)
      .filter(([file]) => file.includes(path.basename(root)))
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

describe('the runtime Electron import graph', () => {
  it('retains every original CommonJS input and Electron edge when sharing root dependencies', async () => {
    const root = fixture({
      'entry.mjs': `
        export { value } from './shared.cjs'
        export { value as imported } from 'conditional-package'
        export const load = () => import('./dynamic.mjs')
      `,
      'future.cjs': `
        module.exports = {
          value: require('conditional-package').value,
          bare: () => require.resolve('electron'),
          subpath: () => require.resolve('electron/main'),
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
    const original = await inspectGraph(entries, {
      separateEntries: true,
      plugins: [injectElectron]
    })
    const shared = await inspectGraph(entries, { plugins: [injectElectron] })

    expect(fixtureInputs(shared, root)).toEqual(fixtureInputs(original, root))
    expect(shared.importers).toEqual(original.importers)
    expect(shared.importers.map((file) => file.slice(file.indexOf(path.basename(root))))).toEqual([
      `${path.basename(root)}/dynamic.mjs`,
      `${path.basename(root)}/future.cjs`,
      `${path.basename(root)}/node_modules/conditional-package/import.mjs`,
      `${path.basename(root)}/node_modules/conditional-package/require.cjs`,
      `${path.basename(root)}/node_modules/desktop-package/index.cjs`
    ])
    const future = Object.entries(shared.metafile.inputs).find(([file]) =>
      file.endsWith('/future.cjs')
    )
    expect(future[1].imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'electron', kind: 'require-resolve', external: true }),
        expect.objectContaining({ path: 'electron/main', kind: 'require-resolve', external: true }),
        expect.objectContaining({ path: './missing.node', external: true })
      ])
    )
  })
})
