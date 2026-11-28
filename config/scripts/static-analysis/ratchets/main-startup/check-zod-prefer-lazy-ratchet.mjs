import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import { resolveOxlintInvocation } from '../../../tool-invocation/oxlint-cli-invocation.mjs'

// Ratchet eager top-level Zod schema constructions downward across Main and Shared.

const BASELINE_PATH = 'config/zod-prefer-lazy-baseline.txt'
const CONFIG_PATH = 'config/oxlint-zod-prefer-lazy-ratchet.json'
const RULE = 'zod-prefer-lazy-schema(prefer-lazy-schema)'
export const HEADER = [
  '# Eager top-level Zod v4 schema constructions per file in src/main and src/shared.',
  '# This is a RATCHET: counts may only go DOWN. Wrap schemas in `lazyZodSchema(() => ...)` instead.',
  '# Prune after a fix: pnpm check:zod-prefer-lazy-ratchet --prune'
]

const IGNORED_PATH_PATTERN =
  /(?:\.(?:test|spec|fixture|test-support)\.|\/__(?:fixtures|tests|mocks)__\/)/

export function countEagerZodSchemas(diagnostics, root = process.cwd()) {
  const counts = new Map()
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== RULE) {
      continue
    }
    const file = path.relative(root, path.resolve(root, diagnostic.filename))
    const key = file.split(path.sep).join('/')
    if (IGNORED_PATH_PATTERN.test(key)) {
      continue
    }
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function collectEagerZodSchemaCounts(root = process.cwd()) {
  const oxlint = resolveOxlintInvocation(path.resolve(root))
  const output = execFileSync(
    oxlint.command,
    [...oxlint.prefixArgs, '--config', CONFIG_PATH, '--format', 'json', 'src/main', 'src/shared'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  )
  return countEagerZodSchemas(JSON.parse(output).diagnostics, path.resolve(root))
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'zod-prefer-lazy',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectEagerZodSchemaCounts,
      unit: 'eager top-level Zod schema(s)',
      fix: [
        'Top-level Zod v4 schemas build and retain schema objects, closures, and Sets in V8 heap',
        'at module load even when never parsed. Wrap them in `lazyZodSchema(() => ...)` from',
        '`src/shared/schema/lazy-zod-schema` (or `z.lazy(() => ...)`), or if eager construction is',
        'strictly required add `// oxlint-disable-next-line zod-prefer-lazy-schema/prefer-lazy-schema -- <why>`.'
      ]
    },
    path.resolve(root),
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
