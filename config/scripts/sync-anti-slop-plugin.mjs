// anti-slop ships raw .ts with no build step, and Node refuses to type-strip anything
// under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so oxlint cannot load
// it from there. Copy the pinned package's source out to a gitignored dir it can load.
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
