import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export function computeClaudeRichOutputSourceHash(root) {
  const filenames = [
    'pnpm-lock.yaml',
    'config/scripts/build-claude-rich-output.mjs',
    'config/scripts/claude-rich-output-build-lock.mjs',
    'config/scripts/claude-rich-output-source-hash.mjs',
    'config/scripts/pnpm-cli-invocation.mjs'
  ]
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') {
        continue
      }
      const file = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(file)
      } else {
        filenames.push(relative(root, file).split(sep).join('/'))
      }
    }
  }
  visit(join(root, 'resources', 'claude-rich-output'))
  const files = filenames.sort().map((filename) => [
    filename,
    createHash('sha256')
      .update(readFileSync(join(root, filename)))
      .digest('hex')
  ])
  return createHash('sha256')
    .update(JSON.stringify(['claude-rich-output-v2', files]))
    .digest('hex')
}
