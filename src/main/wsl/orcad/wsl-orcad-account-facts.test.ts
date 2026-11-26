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
import { readWslHostFacts, WSL_HOST_FACTS_COMMAND } from './wsl-orcad-held-context'

const ROOT_ORCAD =
  '0 /root/.orca-remote/1.4.274/node /root/.orca-remote/1.4.274/orcad.js --json --bind 127.0.0.1 --port 6768'
// /proc/net/tcp rows: `sl local rem st tx:rx tr:tm retrnsmt uid ...`; 0A is LISTEN, 1A70 is 6768.
const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
const listener = (port: string, uid: string): string =>
  `   0: 0100007F:${port} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${uid} 0 1 1`

function run(command: string): ReturnType<typeof readWslAccountFacts> {
  const [userLine = '', keyLine = '', peerLine = ''] = execFileSync('sh', ['-c', command], {
    encoding: 'utf8'
  }).split('\n')
  return readWslAccountFacts(userLine, keyLine, peerLine)
}

describe.skipIf(process.platform === 'win32')('WSL account facts probe', () => {
  const dirs: string[] = []
  afterEach(async () => await removeTempDirs(dirs.splice(0)))

  function sources(processes: string, tcp: string): Parameters<typeof wslAccountFactsCommand>[0] {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wsl-facts-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'ps'), processes)
    writeFileSync(join(dir, 'tcp'), tcp)
    return { processes: `cat '${join(dir, 'ps')}'`, tcpFiles: [join(dir, 'tcp')] }
  }

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

  it("flags another account's orcad only while it holds this host's port", () => {
    const holding = run(
      wslAccountFactsCommand(sources(`${ROOT_ORCAD}\n`, `${HEADER}\n${listener('1A70', '0')}\n`))
    )
    expect(holding?.otherServerAccount?.uid).toBe('0')
    // Another port, or a listener another uid owns (another distro shares the network): ignored.
    const elsewhere = run(
      wslAccountFactsCommand(
        sources(
          `${ROOT_ORCAD}\n`,
          `${HEADER}\n${listener('1A71', '0')}\n${listener('1A70', '1000')}\n`
        )
      )
    )
    expect(elsewhere?.otherServerAccount).toBeUndefined()
    expect(elsewhere?.portCheckUnavailable).toBeUndefined()
  })

  it('fails open, and says so, without a process list', () => {
    const facts = run(wslAccountFactsCommand(sources('', `${HEADER}\n${listener('1A70', '0')}\n`)))
    expect(facts?.otherServerAccount).toBeUndefined()
    expect(facts?.portCheckUnavailable).toBe(true)
  })
})

describe('WSL account facts parsing', () => {
  it("refuses output that isn't the probe's", () => {
    expect(
      readWslAccountFacts('Welcome to Ubuntu', '__ORCA_WSL_KEY__ ', '__ORCA_WSL_PEER__ 0 root')
    ).toBeNull()
  })
})
