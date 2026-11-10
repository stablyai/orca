// Downloads a file or folder (as a zip) from a folder workspace on a paired Orca environment over
// the E2EE runtime RPC, using the desktop's own transfer code. Counterpart of upload-to-environment.ts.
//   node_modules/.bin/tsx cloud/apps/acceptance/desktop/download-from-environment.ts <env> <worktreeId> <relative> <localOut> [--folder]
// --folder needs files.archiveStart on the remote Orca; older builds lack it, so tar the folder there
// first and download the tarball as a file.
import { open } from 'node:fs/promises'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { getDefaultUserDataPath } from '../../../../src/cli/runtime/metadata'
import {
  transferRuntimeFile,
  transferRuntimeFolder,
  type RuntimeDownloadCall
} from '../../../../src/main/runtime-downloads/runtime-download-transfer'

const [environment, worktree, relativePath, out, flag] = process.argv.slice(2) as [string, string, string, string, string?]
const client = new RuntimeClient(getDefaultUserDataPath(), 120_000, null, environment)
const call: RuntimeDownloadCall = async <T,>(method: string, params: unknown, options: { timeoutMs: number }) =>
  (await client.call<T>(method, params, { timeoutMs: options.timeoutMs })).result as T

const sink = await open(out, 'w')
const started = performance.now()
try {
  const input = { call, worktree, relativePath, sink, signal: new AbortController().signal, onProgress: () => {} }
  const r = flag === '--folder' ? await transferRuntimeFolder(input) : await transferRuntimeFile(input)
  console.log(`${relativePath}: ${(r as { bytes: number }).bytes} bytes in ${Math.round(performance.now() - started)} ms -> ${out}`)
} finally {
  await sink.close()
}
process.exit(0)
