import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'

// Every call the phone's Agent Session History makes from a server workspace, list through resume.
const PHONE_HISTORY_RESUME_CALLS = [
  'status.get',
  'worktree.ps',
  'repo.list',
  'folderWorkspace.list',
  'projectGroup.list',
  'aiVault.listSessions',
  'aiVault.resolveSessionTitles',
  'aiVault.prepareSessionResume',
  'terminal.create',
  'terminal.send'
]

describe('mobile method routing', () => {
  // #38639: history rows from the desktop failed the host match against the server's workspace rows.
  it('answers a server workspace history and its resume on the same host', () => {
    const routes = new Set(PHONE_HISTORY_RESUME_CALLS.map((m) => MOBILE_RPC_METHOD_ROUTES.get(m)))
    expect([...routes]).toEqual(['execution-host'])
  })
})
