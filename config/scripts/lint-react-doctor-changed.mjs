import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    return []
  }
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

const changedFiles = new Set([
  ...run('git', ['diff', '--name-only', '--diff-filter=ACMRTUB']),
  ...run('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRTUB']),
  ...run('git', ['ls-files', '--others', '--exclude-standard'])
])

const lintTargets = [...changedFiles].filter(
  (file) => SOURCE_FILE_PATTERN.test(file) && existsSync(file)
)

if (lintTargets.length === 0) {
  process.exit(0)
}

const { command, prefixArgs } = resolveOxlintInvocation()
const result = spawnSync(
  command,
  [...prefixArgs, '--config', 'config/oxlint-react-doctor.json', ...lintTargets],
  { stdio: 'inherit', windowsHide: true }
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
