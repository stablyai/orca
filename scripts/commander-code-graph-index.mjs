import { runProcess } from '@orca/process-host'

export const maxGraphFileBytes = 128 * 1024
const maxHeaderBytes = 96
const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

async function catFile(root, mode, files, payloadBytes = 0) {
  const result = await runProcess({
    program: 'git',
    args: ['--no-replace-objects', 'cat-file', mode],
    cwd: root,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
    input: `${files.map(({ oid }) => oid).join('\n')}\n`,
    captureStdoutAsBytes: true,
    maxOutputBytes: payloadBytes + files.length * maxHeaderBytes,
    killOnOutputLimit: true,
    timeoutMs: 15_000
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Cannot read the Git index blobs')
  }
  return result.stdoutBytes
}

export async function readIndexGraphFiles(root, paths, indexed, available) {
  const blobs = new Map()
  const files = []
  for (const path of paths) {
    const oid = indexed.get(path)
    if (typeof oid === 'string' && fullOid.test(oid)) {
      if (files.length === 500) {
        throw new Error('Git index batch exceeds 500 paths')
      }
      files.push({ path, oid })
    }
  }
  if (!files.length) {
    return blobs
  }

  const metadata = (await catFile(root, '--batch-check', files)).toString('latin1').split('\n')
  if (metadata.pop() !== '' || metadata.length !== files.length) {
    throw new Error('Incomplete Git index metadata')
  }
  const selected = []
  let total = 0
  for (const [i, file] of files.entries()) {
    const header = metadata[i]
    if (header === `${file.oid} missing`) {
      continue
    }
    const match = /^(\w+) (blob|commit|tree|tag) (\d+)$/.exec(header)
    if (!match || match[1] !== file.oid) {
      throw new Error('Invalid Git index metadata')
    }
    const size = Number(match[3])
    if (match[2] === 'blob' && size <= maxGraphFileBytes && total + size <= available) {
      selected.push({ ...file, size })
      total += size
    }
  }
  if (!selected.length) {
    return blobs
  }

  const bytes = await catFile(root, '--batch', selected, total)
  let offset = 0
  for (const { path, oid, size } of selected) {
    const end = bytes.indexOf(10, offset)
    if (end < offset || end - offset > maxHeaderBytes) {
      throw new Error('Invalid Git blob header')
    }
    const header = bytes.toString('latin1', offset, end)
    offset = end + 1
    if (header === `${oid} missing`) {
      continue
    }
    if (header !== `${oid} blob ${size}` || bytes[offset + size] !== 10) {
      throw new Error('Invalid Git blob identity, size or terminator')
    }
    blobs.set(path, bytes.subarray(offset, offset + size))
    offset += size + 1
  }
  if (offset !== bytes.length) {
    throw new Error('Unexpected Git blob data')
  }
  return blobs
}
