import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { readWslAccountFacts, WSL_ACCOUNT_FACTS_COMMAND } from './wsl-orcad-account-facts'

describe('WSL account facts', () => {
  // The probe's own shell carries the orcad argv it scans for, under this account: never a peer.
  it.skipIf(process.platform === 'win32')('names this account and no other server', () => {
    const [userLine = '', peerLine = ''] = execFileSync('sh', ['-c', WSL_ACCOUNT_FACTS_COMMAND], {
      encoding: 'utf8'
    }).split('\n')
    const facts = readWslAccountFacts(userLine, peerLine)
    expect(facts?.account?.uid).toBe(String(process.getuid?.()))
    expect(facts?.otherServerAccount).toBeUndefined()
  })

  it("reports another account's orcad, and refuses output that isn't the command's", () => {
    expect(readWslAccountFacts('__ORCA_WSL_USER__ 1000 alice', '__ORCA_WSL_PEER__ 0 root')).toEqual(
      {
        account: { uid: '1000', name: 'alice' },
        otherServerAccount: { uid: '0', name: 'root' }
      }
    )
    expect(readWslAccountFacts('__ORCA_WSL_USER__ 0 root', '__ORCA_WSL_PEER__  ')).toEqual({
      account: { uid: '0', name: 'root' }
    })
    expect(readWslAccountFacts('Welcome to Ubuntu', '__ORCA_WSL_PEER__ 0 root')).toBeNull()
  })
})
