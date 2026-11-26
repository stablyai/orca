import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDarwinSocketOwnerHelperPathForTests } from './darwin-socket-owner-helper'

/** Points the macOS owner check at a stand-in with the real line protocol that vouches for every
 *  connection, for tests of listener mechanics on any POSIX host. `scans` lists the requests it has
 *  received, each one a scan the real helper would run. */
export async function useVouchingSocketOwnerHelper(
  /** Holds the first answer this long, keeping a lookup in flight while others queue. */
  firstAnswerDelayMs = 0
): Promise<{
  path: string
  scans: () => Promise<string[]>
  restore: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-socket-owner-'))
  const path = join(dir, 'orca-socket-owner')
  const log = join(dir, 'scans.log')
  await writeFile(log, '')
  await writeFile(
    path,
    `#!${process.execPath}\nconst { appendFileSync } = require('node:fs')\nlet held = ${firstAnswerDelayMs}\nrequire('node:readline').createInterface({ input: process.stdin }).on('line', (line) => { appendFileSync(${JSON.stringify(log)}, line + '\\n'); const delay = held; held = 0; setTimeout(() => process.stdout.write('own\\n'), delay) })\n`
  )
  await chmod(path, 0o755)
  setDarwinSocketOwnerHelperPathForTests(path)
  return {
    path,
    scans: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    restore: async () => {
      setDarwinSocketOwnerHelperPathForTests(null)
      await rm(dir, { recursive: true, force: true })
    }
  }
}
