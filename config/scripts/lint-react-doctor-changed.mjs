import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(
  pnpm,
  [
    'exec',
    'oxlint',
    '--config',
    'config/oxlint-react-doctor.json',
    '--deny-warnings',
    ...lintTargets
  ],
  { stdio: 'inherit' }
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
