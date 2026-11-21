import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const versions = new Map<string, string>()
vi.mock('./antigravity-acp-runtime-probe', () => ({
  initializeAntigravityAcp: async (launch: (folder: string) => { command: string }) => ({
    agentInfo: { name: 'Antigravity ACP Server', version: versions.get(launch('').command) }
  })
}))

import {
  antigravityHostAcpReady,
  forgetAntigravityHostAcpChecks,
  readyAntigravityHostAcpVersion
} from './antigravity-host-acp'

const folder = mkdtempSync(join(tmpdir(), 'agy-versions-'))
afterEach(() => {
  forgetAntigravityHostAcpChecks()
  rmSync(folder, { recursive: true, force: true })
})

it('names the version of the agy the latest answer vouched for, even from the cache', async () => {
  const mine = join(folder, 'agy')
  const other = join(folder, 'agy-other')
  writeFileSync(mine, 'a')
  writeFileSync(other, 'bb')
  versions.set(mine, '1.5.13').set(other, '1.6.0')

  expect(readyAntigravityHostAcpVersion()).toBeNull()
  await antigravityHostAcpReady(mine, {}, [])
  await antigravityHostAcpReady(other, {}, [])
  expect(readyAntigravityHostAcpVersion()).toBe('1.6.0')
  // Answered from the cache: no new check runs, and the version is still this binary's.
  await antigravityHostAcpReady(mine, {}, [])
  expect(readyAntigravityHostAcpVersion()).toBe('1.5.13')
})
