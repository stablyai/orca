// Copy pinned anti-slop TS outside node_modules: Node refuses type stripping there, so oxlint cannot load package directly.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const source = resolve(repoRoot, 'node_modules/oxlint-plugin-anti-slop/src')
const target = resolve(repoRoot, '.anti-slop-plugin')

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
// Effect rules are opt-in upstream and this repo does not use Effect; tests would be linted.
rmSync(resolve(target, 'effect'), { recursive: true, force: true })
cpSync(
  resolve(repoRoot, 'node_modules/oxlint-plugin-anti-slop/LICENSE'),
  resolve(target, 'LICENSE')
)
writeFileSync(resolve(target, 'package.json'), '{ "type": "module" }\n')
