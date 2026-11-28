// Explicit offline installation; never download or modify a profile on app startup.
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, lstat, link, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const KEY = 'RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV'
const SHA = 'db63f0ed3525b5b562bdc80158bdca2bbdc1e978f8db5baf28d0db56b3fbdc2a'
const NAME = 'ghostty-vt-1.0.2-small.wasm'

async function readBounded(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) {
      throw new Error('Invalid Rex artifact file')
    }
    const buffer = Buffer.alloc(limit + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count)
      if (!bytesRead) {
        break
      }
      count += bytesRead
    }
    if (count > limit) {
      throw new Error('Rex artifact exceeds limit')
    }
    return buffer.subarray(0, count)
  } finally {
    await file.close()
  }
}

async function install() {
  const [source, signature, profile] = process.argv.slice(2)
  if (
    !source ||
    !signature ||
    !profile ||
    ![source, signature, profile].every(isAbsolute) ||
    !process.getuid
  ) {
    throw new Error(
      'Usage: node install-ghostty-wasm.mjs <absolute wasm> <absolute minisig> <absolute Orca userData>'
    )
  }
  const artifact = await readBounded(source, 2 * 1024 * 1024)
  const sig = await readBounded(signature, 4096)
  if (createHash('sha256').update(artifact).digest('hex') !== SHA) {
    throw new Error('Unapproved Ghostty WASM hash')
  }
  const directory = join(profile, 'rex')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) {
    throw new Error('Rex artifact directory must be private and owned by the current user')
  }
  const staged = join(directory, `.${randomUUID()}.wasm`)
  const stagedSig = `${staged}.minisig`
  async function stage(path, data) {
    const file = await open(path, 'wx', 0o600)
    try {
      await file.writeFile(data)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  try {
    await stage(staged, artifact)
    await stage(stagedSig, sig)
    await promisify(execFile)('minisign', ['-Vm', staged, '-x', stagedSig, '-P', KEY], {
      timeout: 10000,
      maxBuffer: 16384
    })
    const destination = join(directory, NAME)
    try {
      await link(staged, destination)
    } catch (error) {
      if (
        error?.code !== 'EEXIST' ||
        createHash('sha256')
          .update(await readBounded(destination, 2 * 1024 * 1024))
          .digest('hex') !== SHA
      ) {
        throw error
      }
    }
    console.log('Verified and installed', destination)
  } finally {
    await unlink(staged).catch(() => undefined)
    await unlink(stagedSig).catch(() => undefined)
  }
}
install().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
