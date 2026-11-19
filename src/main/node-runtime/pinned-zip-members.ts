// Extract pinned members in-process without requiring unzip; reject unexpected entries or sizes.

import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import { writeAll } from './runtime-archive-download'

export async function extractPinnedZipMembers(
  archivePath: string,
  directory: string,
  members: readonly { path: string; bytes: number }[],
  label: string,
  signal: AbortSignal
): Promise<void> {
  const expected = new Map(members.map((member) => [member.path, member.bytes]))
  const written = new Map<string, number>()
  const pending: { name: string; data: Uint8Array }[] = []
  const failures: string[] = []
  const unzip = new Unzip((file) => {
    const bytes = expected.get(file.name)
    if (bytes === undefined || written.has(file.name)) {
      failures.push(`has an unexpected entry ${JSON.stringify(file.name)}`)
      return
    }
    written.set(file.name, 0)
    file.ondata = (error, data) => {
      if (error) {
        failures.push(`has an unreadable ${file.name}: ${error.message}`)
        return
      }
      const total = (written.get(file.name) ?? 0) + data.byteLength
      if (total > bytes) {
        failures.push(`has a ${file.name} larger than expected`)
        return
      }
      written.set(file.name, total)
      pending.push({ name: file.name, data })
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  const handles = new Map<string, FileHandle>()
  // Flush each decoded chunk before reading another to bound memory.
  const push = async (chunk: Uint8Array, final: boolean): Promise<void> => {
    unzip.push(chunk, final)
    for (const { name, data } of pending.splice(0)) {
      const handle = handles.get(name) ?? (await open(join(directory, name), 'wx', 0o700))
      handles.set(name, handle)
      await writeAll(handle, data)
    }
    if (failures.length > 0) {
      throw new Error(`The ${label} archive ${failures[0]}.`)
    }
  }
  try {
    for await (const chunk of createReadStream(archivePath, { signal })) {
      await push(chunk, false)
    }
    await push(new Uint8Array(0), true)
  } finally {
    await Promise.all([...handles.values()].map((handle) => handle.close()))
  }
  if (members.some((member) => written.get(member.path) !== member.bytes)) {
    throw new Error(`The ${label} archive is missing a file or has one cut short.`)
  }
}
