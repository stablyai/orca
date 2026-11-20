import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const versions = new Map<string, string>()
const appendCapable = new Set<string>()
vi.mock('./antigravity-acp-runtime-probe', () => ({
  initializeAntigravityAcp: async (
    launch: (folder: string) => { command: string },
    _timeout: number,
    _signal: unknown,
    onInitialized?: (connection: unknown, initialized: unknown, folder: string) => Promise<void>
  ) => {
    const { command } = launch('')
    const initialized = {
      protocolVersion: 1,
      agentInfo: { name: 'Antigravity ACP Server', version: versions.get(command) },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, list: {} },
        _meta: appendCapable.has(command)
          ? { antigravity: { systemPrompt: { append: true } } }
          : { antigravity: {} }
      }
    }
    await onInitialized?.({ listSessions: async () => ({}) }, initialized, '')
    return initialized
  }
}))

import {
  antigravityHostAcpReady,
  forgetAntigravityHostAcpChecks,
  readyAntigravityHostAcpVersion
} from './antigravity-host-acp'

let folder = ''
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'agy-versions-'))
})
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

it('leaves only a chat with standing instructions to Orca when agy cannot append to its prompt', async () => {
  const plain = join(folder, 'agy-plain')
  const capable = join(folder, 'agy-capable')
  writeFileSync(plain, 'p')
  writeFileSync(capable, 'cc')
  versions.set(plain, '1.5.13').set(capable, '1.5.13')
  appendCapable.add(capable)

  expect(await antigravityHostAcpReady(plain, {}, [], false)).toBe(true)
  expect(await antigravityHostAcpReady(plain, {}, [], true)).toBe(false)
  expect(await antigravityHostAcpReady(capable, {}, [], true)).toBe(true)
})
