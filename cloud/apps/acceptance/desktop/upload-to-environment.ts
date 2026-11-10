// Uploads local files into a folder workspace on a paired Orca environment (E2EE runtime RPC,
// files.writeBase64Chunk). Used to stage the desktop acceptance run on a remote Mac without SSH.
// Contents are never printed.
//   node_modules/.bin/tsx cloud/apps/acceptance/desktop/upload-to-environment.ts <env> <worktreeId> <local>=<relative> ...
import { readFileSync } from 'node:fs'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { getDefaultUserDataPath } from '../../../../src/cli/runtime/metadata'

const [environment, worktree, ...pairs] = process.argv.slice(2) as [string, string, ...string[]]
const client = new RuntimeClient(getDefaultUserDataPath(), 120_000, null, environment)
const CHUNK = 192 * 1024
for (const pair of pairs) {
  const [local, relativePath] = pair.split('=') as [string, string]
  const bytes = readFileSync(local)
  const started = performance.now()
  for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK) {
    const contentBase64 = bytes.subarray(offset, offset + CHUNK).toString('base64')
    await client.call('files.writeBase64Chunk', { worktree, relativePath, contentBase64, append: offset > 0, expectedExecutionHostId: 'local' }, { timeoutMs: 120_000 })
    if (bytes.length === 0) {
      break
    }
  }
  console.log(`${relativePath}: ${bytes.length} bytes in ${Math.round(performance.now() - started)} ms`)
}
process.exit(0)
