import { mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createMinidumpFileSource } from './minidump-file-source'
import { parseMinidumpCrashSignature } from './minidump-crash-signature'

const roots: string[] = []
const LINE = '[8104:1234:0815/143022.123456:FATAL:render_frame_impl.cc(4821)] Check failed: !x.'

function header(): Buffer {
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32LE(0x504d444d, 0)
  bytes.writeUInt32LE(32, 12)
  return bytes
}

async function sourceFile() {
  const root = await mkdtemp(join(tmpdir(), 'orca-minidump-source-'))
  roots.push(root)
  const path = join(root, 'dump.dmp')
  await writeFile(path, header())
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('does not read outside the opened extent, including truncation and EOF', async () => {
  const path = await sourceFile()
  const handle = await open(path, 'r+')
  try {
    const source = createMinidumpFileSource(handle, 32)
    await handle.write(Buffer.from(LINE), 0, LINE.length, 32)
    expect(await source.read(32, 4)).toEqual(Buffer.alloc(0))
    expect((await parseMinidumpCrashSignature(source))?.checkMessage).toBeUndefined()
    await truncate(path, 4)
    const truncated = createMinidumpFileSource(handle, 32)
    expect(await parseMinidumpCrashSignature(truncated)).toBeNull()
  } finally {
    await handle.close()
  }
})
