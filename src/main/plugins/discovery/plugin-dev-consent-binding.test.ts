import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { discoverPlugins, isInvalidDiscoveredPlugin } from './plugin-discovery'

let root: string
let dir: string

const manifest = (key: string) => ({
  manifestVersion: 2,
  id: 'demo',
  publisher: 'acme',
  name: 'Demo',
  version: '0.1.0',
  engines: { orca: '>=1.4.246' },
  execution: 'trusted-worker',
  pluginApi: 1,
  main: 'worker.js',
  contributes: {
    commands: [{ id: 'demo.run', title: 'Run' }],
    keybindings: [{ command: 'demo.run', key }],
    vmRecipes: [{ path: 'recipes/vm.json' }]
  }
})

async function consentFingerprint(): Promise<string> {
  const [plugin] = await discoverPlugins({
    pluginsDir: join(root, 'installed'),
    devPluginPaths: [dir],
    hostVersion: '99.0.0',
    requiredPluginKeys: []
  })
  if (!plugin || isInvalidDiscoveredPlugin(plugin)) {
    throw new Error(`plugin did not load: ${plugin && 'error' in plugin ? plugin.error : ''}`)
  }
  return plugin.consentFingerprint
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-dev-consent-'))
  dir = join(root, 'plugin')
  await mkdir(join(dir, 'recipes'), { recursive: true })
  await writeFile(join(dir, 'orca-plugin.json'), JSON.stringify(manifest('CmdOrCtrl+Shift+9')))
  await writeFile(join(dir, 'worker.js'), 'export function activate() {}\n')
  await writeFile(join(dir, 'recipes', 'vm.json'), '{"create":"a"}')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('binds a dev folder approval to its shortcuts and recipes but not its worker code', async () => {
  const approved = await consentFingerprint()
  await writeFile(join(dir, 'worker.js'), 'export function activate() { console.log(1) }\n')
  expect(await consentFingerprint()).toBe(approved)

  await writeFile(join(dir, 'recipes', 'vm.json'), '{"create":"b"}')
  const recipeEdited = await consentFingerprint()
  expect(recipeEdited).not.toBe(approved)

  await writeFile(join(dir, 'orca-plugin.json'), JSON.stringify(manifest('CmdOrCtrl+Shift+8')))
  expect(await consentFingerprint()).not.toBe(recipeEdited)
})
