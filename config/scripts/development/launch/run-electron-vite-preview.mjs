import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareStandaloneDevMenuBar } from './dev-menu-bar.mjs'

if (!process.argv.slice(2).some((arg) => ['--help', '-h', '--version'].includes(arg))) {
  prepareStandaloneDevMenuBar()
}
const require = createRequire(import.meta.url)
const cli = path.join(
  path.dirname(require.resolve('electron-vite/package.json')),
  'bin/electron-vite.js'
)
process.argv.splice(1, 1, cli, 'preview')
await import(pathToFileURL(cli).href)
