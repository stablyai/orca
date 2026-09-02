// Why: installs node-backed sha256sum/mv/rm shims on PATH so the real guest script can be
// interfered with at exact points - a hash read, an install rename, a source removal.
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function installDrainInterferenceShims(
  binDir: string,
  options: { killAfterDestinationInstall?: boolean; killAfterSourceRemoval?: boolean }
): void {
  const shimPath = join(binDir, 'sha256sum')
  writeFileSync(
    shimPath,
    `#!/usr/bin/env node
  const { createHash } = require('node:crypto')
  const fs = require('node:fs')
  const file = process.argv[process.argv.length - 1]
  process.stdout.write(
  createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + file + '\\n'
  )
  const calls = Number(fs.readFileSync(process.env.HASH_COUNTER, 'utf8')) + 1
  fs.writeFileSync(process.env.HASH_COUNTER, String(calls))
  if (process.env.REWRITE_AFTER && calls === Number(process.env.REWRITE_AFTER)) {
  fs.writeFileSync(process.env.REWRITE_TARGET, process.env.REWRITE_BYTES)
  }
  // Why: an atomic rename leaves the pinned hard link on the OLD inode, so its hash still
  // matches while the path now resolves elsewhere. Only an inode identity check sees that.
  if (process.env.REPLACE_ON_HASH_OF && file.includes(process.env.REPLACE_ON_HASH_OF)) {
  const staged = process.env.REPLACE_PATH + '.intruder'
  fs.writeFileSync(staged, process.env.REPLACE_BYTES)
  fs.renameSync(staged, process.env.REPLACE_PATH)
  }
  `
  )
  chmodSync(shimPath, 0o755)
  if (options.killAfterDestinationInstall || options.killAfterSourceRemoval) {
    const mvShimPath = join(binDir, 'mv')
    writeFileSync(
      mvShimPath,
      `#!/usr/bin/env node
  const { spawnSync } = require('node:child_process')
  const fs = require('node:fs')
  const args = process.argv.slice(2)
  const result = spawnSync('/bin/mv', args, { stdio: 'inherit' })
  const from = args.at(-2) ?? ''
  const to = args.at(-1) ?? ''
  const sourceInstalled =
  process.env.KILL_SOURCE === '1' &&
  from.endsWith('/legacy/auth.json') &&
  to.endsWith('.orca-drain-live-source')
  const destinationInstalled =
  process.env.KILL_DESTINATION === '1' &&
  from.includes('/account/auth.json.orca-drain-snapshot-') &&
  to.endsWith('/account/auth.json')
  if (result.status === 0 && (sourceInstalled || destinationInstalled)) {
  process.kill(process.ppid, 'SIGKILL')
  }
  process.exit(result.status ?? 1)
  `
    )
    chmodSync(mvShimPath, 0o755)
  }
}
