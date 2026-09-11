import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_PAIRED_RUNTIME_CAPABILITIES
} from '../../shared/protocol-version'
import {
  electronRemoteRuntimeClientCapabilities,
  resetStructuredChatRemoteReadSourceForTests,
  setStructuredChatRemoteReadSource,
  structuredChatRemoteReadEnabled
} from './structured-reader-advertisement'

const OWNER = 'structured-reader-advertisement.ts'

function ipcSourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      return ipcSourceFiles(full)
    }
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : []
  })
}

afterEach(() => {
  resetStructuredChatRemoteReadSourceForTests()
})

describe('what this desktop advertises to a paired host', () => {
  it('carries the structured reader and the hold while the setting is on or unset', () => {
    expect(structuredChatRemoteReadEnabled()).toBe(true)
    setStructuredChatRemoteReadSource(() => true)
    for (const capability of STRUCTURED_AGENT_SESSION_PAIRED_RUNTIME_CAPABILITIES) {
      expect(electronRemoteRuntimeClientCapabilities()).toContain(capability)
    }
    // The hold is what lets a pane reserve a paired host's session — and, once taken, let it go.
    // It is advertised on every paired connection, never per-user: the create switch is a client
    // policy, and withdrawing a negotiated term on a switch flip would strand a held session.
    expect(electronRemoteRuntimeClientCapabilities()).toContain(
      STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY
    )
  })

  it('drops only the paired surface when the setting is off, so the retreat is not a new client', () => {
    setStructuredChatRemoteReadSource(() => false)
    const advertised = electronRemoteRuntimeClientCapabilities()
    for (const capability of STRUCTURED_AGENT_SESSION_PAIRED_RUNTIME_CAPABILITIES) {
      expect(advertised, `${capability} is withheld`).not.toContain(capability)
    }
    // Everything else is untouched: a user retreating from structured reads must not also lose
    // page placement or the retirement-proof ledger and start looking like some other client.
    const withheld = new Set<string>(STRUCTURED_AGENT_SESSION_PAIRED_RUNTIME_CAPABILITIES)
    expect(advertised).toEqual(
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES.filter((capability) => !withheld.has(capability))
    )
  })

  it('keeps advertising when the settings read throws rather than retreating silently', () => {
    setStructuredChatRemoteReadSource(() => {
      throw new Error('settings store unavailable')
    })
    expect(electronRemoteRuntimeClientCapabilities()).toEqual(
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
  })

  it('is the only place a paired connection reads the list from', () => {
    const offenders = ipcSourceFiles(__dirname)
      .filter((file) => !file.endsWith(OWNER))
      .filter((file) =>
        readFileSync(file, 'utf8').includes('ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES')
      )
    // A call site holding the constant directly advertises the reader whatever the user set, and
    // nothing about it looks wrong: it is the same list this module returns on the default path.
    expect(offenders, 'these advertise past the retreat lever').toEqual([])
  })
})
