import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../shared/testing/remove-temp-dirs.test-support'
import {
  readWslAccountFacts,
  WSL_ACCOUNT_FACTS_COMMAND,
  wslAccountFactsCommand
} from './wsl-orcad-account-facts'
import {
  readWslHostFacts,
  refuseUnpairedDefaultAccount,
  WSL_HOST_FACTS_COMMAND
} from './wsl-orcad-held-context'
import { withWslHostLinuxUser } from './wsl-orcad-host-user'

// A managed orcad's argv as `ps -eo uid=,args=` prints it; it listens on 6800 or the next free port.
const ROOT_ORCAD =
  '    0 /root/.orca-remote/1.4.274/node /root/.orca-remote/1.4.274/orcad.js --json --bind 127.0.0.1 --port 6768'

function run(command: string): ReturnType<typeof readWslAccountFacts> {
  const [userLine = '', keyLine = '', peerLine = ''] = execFileSync('sh', ['-c', command], {
    encoding: 'utf8'
  }).split('\n')
  return readWslAccountFacts(userLine, keyLine, peerLine)
}

describe.skipIf(process.platform === 'win32')('WSL account facts probe', () => {
  const dirs: string[] = []
  afterEach(async () => await removeTempDirs(dirs.splice(0)))

  // The probe's own shell carries the orcad argv it scans for, under this account: never a peer.
  it('names this account and no other server', () => {
    const facts = run(WSL_ACCOUNT_FACTS_COMMAND)
    expect(facts?.account?.uid).toBe(String(process.getuid?.()))
    expect(facts?.otherServerAccount).toBeUndefined()
  })

  // The whole facts command, in the distro's usual sh (dash on Ubuntu): the account lines parse.
  it('keeps the facts output in the shape the parser accepts', () => {
    const shell = process.platform === 'darwin' ? '/bin/dash' : 'sh'
    const output = execFileSync(shell, ['-c', WSL_HOST_FACTS_COMMAND], { encoding: 'utf8' })
    expect(readWslHostFacts(output)?.account?.uid).toBe(String(process.getuid?.()))
  })

  it("names another account's managed orcad", () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wsl-facts-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'ps'), `${ROOT_ORCAD}\n`)
    const facts = run(wslAccountFactsCommand({ processes: `cat '${join(dir, 'ps')}'` }))
    expect(facts?.otherServerAccount?.uid).toBe('0')
  })
})

describe('WSL account facts parsing', () => {
  it("refuses output that isn't the probe's, and reads a missing key as none", () => {
    expect(
      readWslAccountFacts('Welcome to Ubuntu', '__ORCA_WSL_KEY__ ', '__ORCA_WSL_PEER__  ')
    ).toBeNull()
    expect(
      readWslAccountFacts(
        '__ORCA_WSL_USER__ 1001 qauser',
        '__ORCA_WSL_KEY__ ',
        '__ORCA_WSL_PEER__  '
      )
    ).toEqual({ account: { uid: '1001', name: 'qauser' }, ownKey: null })
  })
})

// #49180 repro: after the default user became qauser, Orca deployed a new server for it and then
// refused it as foreign. The check runs on the facts, before anything is deployed.
describe('an unpinned host whose default account lacks the paired key', () => {
  const qauser = { account: { uid: '1001', name: 'qauser' }, ownKey: 'QQQQ' }
  it('is refused before deploy unless that account holds the key or the host is pinned', async () => {
    expect(() => refuseUnpairedDefaultAccount('Ubuntu', qauser, 'RRRR')).toThrow(/qauser/)
    expect(() =>
      refuseUnpairedDefaultAccount('Ubuntu', { ...qauser, ownKey: null }, 'RRRR')
    ).toThrow(/qauser/)
    expect(() => refuseUnpairedDefaultAccount('Ubuntu', qauser, 'QQQQ')).not.toThrow()
    expect(() => refuseUnpairedDefaultAccount('Ubuntu', qauser, undefined)).not.toThrow()
    await withWslHostLinuxUser('Ubuntu', 'root', async () =>
      expect(() => refuseUnpairedDefaultAccount('Ubuntu', qauser, 'RRRR')).not.toThrow()
    )
  })
})
