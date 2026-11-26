import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDarwinSocketOwnerHelperPathForTests } from './darwin-socket-owner-helper'

/** Points the macOS owner check at a stand-in with the real line protocol that vouches for every
 *  connection, for tests of listener mechanics on any POSIX host. `scans` lists the requests it has
 *  received, each one a scan the real helper would run. */
export async function useVouchingSocketOwnerHelper(
  /** Holds the first answer until `releaseFirstAnswer`, keeping a lookup in flight while others queue. */
  holdFirstAnswer = false
): Promise<{
  path: string
  scans: () => Promise<string[]>
  releaseFirstAnswer: () => Promise<void>
  restore: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-socket-owner-'))
  const path = join(dir, 'orca-socket-owner')
  const log = join(dir, 'scans.log')
  const released = join(dir, 'released')
  await writeFile(log, '')
  await writeFile(
    path,
    `#!${process.execPath}
const { appendFileSync, existsSync, rmSync } = require('node:fs')
let hold = ${holdFirstAnswer}
const answer = () => process.stdout.write('own\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(${JSON.stringify(log)}, line + '\\n')
  if (!hold) return answer()
  hold = false
  const wait = setInterval(() => existsSync(${JSON.stringify(released)}) && (clearInterval(wait), rmSync(${JSON.stringify(released)}), answer()), 10)
})
`
  )
  await chmod(path, 0o755)
  setDarwinSocketOwnerHelperPathForTests(path)
  return {
    path,
    scans: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    releaseFirstAnswer: () => writeFile(released, ''),
    restore: async () => {
      setDarwinSocketOwnerHelperPathForTests(null)
      await rm(dir, { recursive: true, force: true })
    }
  }
}
