// Headless file + folder download from a cloud workspace over the E2EE pairing, using the desktop's
// own download transfer code (src/main/runtime-downloads) and the CLI's runtime client. No window.
//   ORCA_PAIRING_CODE=<code> <repo>/node_modules/.bin/tsx desktop/runtime-download.ts <worktreeId> <file> <folder> <outDir>
// Prints one JSON line: {file:{bytes,ms,sha256}, folder:{bytes,ms,zipOk}} or {error}.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { transferRuntimeFile, transferRuntimeFolder, type RuntimeDownloadCall } from '../../../../src/main/runtime-downloads/runtime-download-transfer'

const [worktree, file, folder, outDir] = process.argv.slice(2) as [string, string, string, string]
const pairing = process.env.ORCA_PAIRING_CODE
if (!pairing) {
  throw new Error('ORCA_PAIRING_CODE required')
}
const client = new RuntimeClient(mkdtempSync(join(tmpdir(), 'orca-dl-')), 120_000, pairing, null)
const call: RuntimeDownloadCall = async <T,>(method: string, params: unknown, options: { timeoutMs: number }) =>
  (await client.call<T>(method, params, { timeoutMs: options.timeoutMs })).result as T

async function run(kind: 'file' | 'folder', relativePath: string, path: string) {
  const sink = await open(path, 'w')
  const started = performance.now()
  try {
    const input = { call, worktree, relativePath, sink, signal: new AbortController().signal, onProgress: () => {} }
    const r = kind === 'file' ? await transferRuntimeFile(input) : await transferRuntimeFolder(input)
    return { bytes: (r as { bytes: number }).bytes, ms: Math.round(performance.now() - started) }
  } finally {
    await sink.close()
  }
}

try {
  const f = await run('file', file, join(outDir, 'file.bin'))
  const sha256 = createHash('sha256').update(readFileSync(join(outDir, 'file.bin'))).digest('hex')
  let folderResult: Record<string, unknown>
  try {
    const z = await run('folder', folder, join(outDir, 'folder.zip'))
    // ZIP end-of-central-directory signature at the tail: the archive is complete.
    const zip = readFileSync(join(outDir, 'folder.zip'))
    folderResult = { ...z, zipOk: zip.subarray(Math.max(0, zip.length - 22)).readUInt32LE(0) === 0x06054b50 }
  } catch (error) {
    folderResult = { error: String(error instanceof Error ? error.message : error).slice(0, 200) }
  }
  console.log(JSON.stringify({ file: { ...f, sha256 }, folder: folderResult }))
} catch (error) {
  console.log(JSON.stringify({ error: String(error instanceof Error ? `${error.name}: ${error.message}` : error).slice(0, 400) }))
}
process.exit(0)
