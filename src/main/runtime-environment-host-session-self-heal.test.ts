import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments
} from '../shared/runtime-environment-store'
import { encodePairingOffer } from '../shared/pairing'
import { selfHealRuntimeHostWorkspaceSessions } from './runtime-environment-host-session-self-heal'

let userDataPath: string
const prune = vi.fn(() => ['runtime:removed'])
const log = vi.fn()

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-host-session-heal-'))
  prune.mockClear()
  log.mockClear()
})

afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

function heal(listKnownEnvironments = listEnvironments): void {
  selfHealRuntimeHostWorkspaceSessions({
    store: { pruneOrphanedRuntimeHostWorkspaceSessions: prune },
    userDataPath,
    listKnownEnvironments,
    log
  })
}

describe('runtime host workspace session self-heal', () => {
  it('uses the saved registry to preserve known environments', () => {
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'saved',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'test-token',
        publicKeyB64: Buffer.alloc(32, 1).toString('base64')
      })
    })
    heal()
    expect(prune).toHaveBeenCalledExactlyOnceWith(new Set([environment.id]))
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('logs the pruned host ids at warn level', () => {
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'saved',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'test-token',
        publicKeyB64: Buffer.alloc(32, 1).toString('base64')
      })
    })
    heal()
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('runtime:removed'))
  })

  it('refuses to prune when the registry is valid but lists no environments', () => {
    // A lost concurrent write can empty the registry; an empty pass would wipe every runtime tab.
    writeFileSync(
      getEnvironmentStorePath(userDataPath),
      JSON.stringify({ version: 1, environments: [] })
    )
    heal()
    expect(prune).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('empty'))
  })

  it.each(['missing', 'invalid', 'unsupported-version'])(
    'preserves sessions when the registry is %s',
    (state) => {
      if (state !== 'missing') {
        writeFileSync(
          getEnvironmentStorePath(userDataPath),
          state === 'invalid' ? '{broken' : JSON.stringify({ version: 2, environments: [] })
        )
      }
      heal()
      expect(prune).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    }
  )

  it('does not turn a registry disappearing before the read into an empty registry', () => {
    const path = getEnvironmentStorePath(userDataPath)
    writeFileSync(path, JSON.stringify({ version: 1, environments: [] }))
    heal((directory, options) => {
      rmSync(path)
      return listEnvironments(directory, options)
    })
    expect(prune).not.toHaveBeenCalled()
    expect(listEnvironments(userDataPath)).toEqual([])
  })
})
