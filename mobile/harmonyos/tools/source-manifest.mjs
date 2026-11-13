import { readdirSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'

const rootFiles = [
  '.editorconfig',
  '.oxfmtrc.json',
  '.gitignore',
  'LICENSE',
  'NOTICE',
  'README.md',
  'build-profile.example.json5',
  'oh-package.json5',
  'hvigorfile.ts',
  'entry/build-profile.json5',
  'entry/oh-package.json5',
  'entry/hvigorfile.ts',
  'hvigor/hvigor-config.json5'
]
const sourceDirectories = ['AppScope', 'entry/src', 'tools']
const documentation = ['architecture.md', 'development.md', 'device-testing.md', 'parity.md']
export function sourceFiles(root) {
  const files = [...rootFiles, ...documentation.map((name) => `docs/${name}`)]
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split('\\').join('/')
      if (entry.isSymbolicLink()) {
        throw new Error(`Source symlink requires explicit review: ${name}`)
      }
      if (entry.isDirectory()) {
        if (!['node_modules', 'build', '.hvigor'].includes(entry.name)) {
          visit(path)
        }
      } else if (entry.isFile()) {
        files.push(name)
      }
    }
  }
  for (const directory of sourceDirectories) {
    visit(join(root, directory))
  }
  for (const name of files) {
    if (!lstatSync(join(root, name)).isFile()) {
      throw new Error(`Missing source: ${name}`)
    }
    if (
      name === 'build-profile.json5' ||
      /(?:^|\/)(?:local\.properties|\.env)(?:$|\.)|\.(?:p12|pfx|pem|key|cer|p7b|hap|app|log)$/.test(
        name
      )
    ) {
      throw new Error(`Local material cannot enter source export: ${name}`)
    }
  }
  return [...new Set(files)].sort()
}
