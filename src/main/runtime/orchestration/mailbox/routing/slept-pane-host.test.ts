import { expect, it } from 'vitest'
import type { SleptMailRecord } from './mail-wake-obligation'
import { SleptPaneHost } from './slept-pane-host'

it('matches a slept pane to its host however the saved host id is spelled', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host check reads only worktreeId and connectionId.
  const record = { worktreeId: 'repo-wsl::/home/u/w', connectionId: null } as SleptMailRecord
  const hosts = new SleptPaneHost(
    { hostOf: () => 'runtime:wsl:Ubuntu', records: new Map([['pane', record]]) },
    () => ({ connectionId: null, executionHostId: 'runtime:wsl:Ubuntu' })
  )
  expect(hosts.on('runtime:wsl%3AUbuntu')('pane')).toBe(true)
  expect(hosts.on('runtime:wsl:Ubuntu')('pane')).toBe(true)
  expect(hosts.on('runtime:other')('pane')).toBe(false)
  expect(hosts.on('local')('pane')).toBe(false)
})
