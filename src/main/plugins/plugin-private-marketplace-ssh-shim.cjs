const { spawnSync } = require('node:child_process')

const command = process.argv.at(-1) ?? ''
const match = /^git-upload-pack '([^']+)'$/.exec(command)
const repositories = JSON.parse(process.env.ORCA_TEST_SSH_REPOSITORIES ?? '{}')
const repository = match ? repositories[match[1]] : undefined
if (!repository) {
  process.stderr.write(`unknown test SSH repository: ${command}\n`)
  process.exit(1)
}
const result = spawnSync('git', ['upload-pack', repository], { stdio: 'inherit' })
process.exit(result.status ?? 1)
