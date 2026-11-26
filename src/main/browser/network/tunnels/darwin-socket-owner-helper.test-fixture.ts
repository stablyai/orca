import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDarwinSocketOwnerHelperPathForTests } from './darwin-socket-owner-helper'

/** Points the macOS owner check at a stand-in with the real line protocol that vouches for every
 *  connection, for tests of listener mechanics on any POSIX host. Returns its path and a cleanup. */
export async function useVouchingSocketOwnerHelper(): Promise<{
  path: string
  restore: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-socket-owner-'))
  const path = join(dir, 'orca-socket-owner')
  await writeFile(
    path,
    `#!${process.execPath}\nrequire('node:readline').createInterface({ input: process.stdin }).on('line', () => process.stdout.write('own\\n'))\n`
  )
  await chmod(path, 0o755)
  setDarwinSocketOwnerHelperPathForTests(path)
  return {
    path,
    restore: async () => {
      setDarwinSocketOwnerHelperPathForTests(null)
      await rm(dir, { recursive: true, force: true })
    }
  }
}
