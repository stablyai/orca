import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const DOCS_ONLY_FILES = new Set([
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CLAUDE.md',
  'Agents.md',
  'Claude.md',
  '.github/CONTRIBUTING.md',
  '.github/pull_request_template.md',
  '.github/CODEOWNERS'
])

const DOCS_ONLY_PREFIXES = ['docs/', '.github/ISSUE_TEMPLATE/']

export function isDocsOnlyPath(file) {
  if (DOCS_ONLY_FILES.has(file)) {
    return true
  }
  if (DOCS_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return true
  }
  return /^README\.[^/]+\.md$/.test(file)
}

export function shouldRunPrChecks(changedFiles) {
  // Why empty-run: a silent empty diff is more likely a detector bug than a
  // genuine no-op PR, so fail closed and keep the expensive jobs.
  if (changedFiles.length === 0) {
    return true
  }
  return changedFiles.some((file) => !isDocsOnlyPath(file))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = readFileSync(0, 'utf8').split('\n').filter(Boolean)
  process.stdout.write(shouldRunPrChecks(files) ? 'true\n' : 'false\n')
}
