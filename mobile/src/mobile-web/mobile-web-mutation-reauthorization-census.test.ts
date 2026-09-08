import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_OPERATIONS,
  type MobileWebBridgeCapability
} from '../../../src/shared/mobile-web/bridge-operation-registry'

const SHELL_DIR = resolve(__dirname)
const REAUTHORIZATION =
  /(?:\.(?:assertHostWorkspaceBinding|assertHostRepoBinding|assertHostedTarget)|\bassertMobileWebHostRequestScope)\(/g
const HANDLE_RESOLUTION =
  /\.(?:hostWorkspaceId|hostRepoId|hostConnectionId|resolveGitHub|resolveGitLab|resolveLinear)\(/

/** Every module that reauthorizes an opaque handle, and how many times. Pinned so deleting a
 * reauthorization arm fails here even when the surrounding module keeps others. Host forwarding
 * reauthorizes through `assertMobileWebHostRequestScope`, so its declaration, its own assert and
 * every call site count. This counts sites; it does not prove each one sits after the awaited
 * read it guards. */
const REAUTHORIZATION_SITES: Record<string, number> = {
  'mobile-web-host-requests.ts': 5,
  'mobile-web-host-subscriptions.ts': 1,
  'mobile-web-native-chat-binding.ts': 2
}

// Device-only mutations and handles consumed in one awaited call have no reauthorization window.
const NO_REAUTHORIZATION_WINDOW: readonly string[] = [
  'native.alert',
  'native.clipboardWrite',
  'native.hapticFeedback',
  'native.hapticSelection',
  'native.notificationPermission',
  'native.notificationPreference',
  'native.openSystemSettings',
  'native.diagnosticsSubmit',
  'native.openExternal',
  'native.pagePreferences',
  'file.markdownDraftWrite',
  'native.sessionChatDraftWrite',
  'native.terminalCustomKeysUpdate',
  'native.terminalTextScaleUpdate',
  'nativeChat.attachImage',
  'nativeChat.pasteImages',
  'nativeChat.pendingWrite',
  'nativeChat.releaseImages',
  'sourceControl.cancelCommitMessageGeneration',
  'sourceControl.generateCommitMessage',
  'terminal.attachImage',
  'terminal.clipboardPaste'
]

function shellSources(): Map<string, string> {
  return new Map(
    readdirSync(SHELL_DIR)
      .filter(
        (name) =>
          name.endsWith('.ts') &&
          !name.includes('.test.') &&
          !name.startsWith('mobile-web-production-')
      )
      .map((name) => [name, readFileSync(join(SHELL_DIR, name), 'utf8')])
  )
}

function dispatchModules(sources: Map<string, string>, operation: string): string[] {
  // The generic arm delegates handle resolution to its bounded executor.
  if (operation === 'hostRequest') {
    expect(sources.get('mobile-web-workspace-capability.ts')).toContain(
      'executeMobileWebHostRequest({'
    )
    return ['mobile-web-host-requests.ts']
  }
  const patterns = [
    new RegExp(`operation === '${operation}'`),
    new RegExp(`case '${operation}':`),
    new RegExp(`'${operation}'(?=[,\\]])`),
    new RegExp(`^\\s*'${operation}',?$`, 'm'),
    new RegExp(`\\bstartsWith\\('${operation}'\\)`)
  ]
  return [...sources]
    .filter(([, text]) => patterns.some((pattern) => pattern.test(text)))
    .map(([name]) => name)
}

function mutations(): string[] {
  return Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap(([capability, operations]) =>
    Object.entries(operations)
      .filter(([, kind]) => kind === 'mutation')
      .map(([operation]) => `${capability}.${operation}`)
  )
}

describe('mobile web mutation reauthorization census', () => {
  const sources = shellSources()

  it('keeps every recorded reauthorization site in place', () => {
    const derived: Record<string, number> = {}
    for (const [name, text] of sources) {
      const count = (text.match(REAUTHORIZATION) ?? []).length
      if (count > 0) {
        derived[name] = count
      }
    }

    expect(derived).toEqual(REAUTHORIZATION_SITES)
  })

  it('routes every mutation to a reauthorizing module or a recorded exemption', () => {
    const unaccounted: string[] = []
    for (const operation of mutations()) {
      if (NO_REAUTHORIZATION_WINDOW.includes(operation)) {
        continue
      }
      const modules = dispatchModules(sources, operation.slice(operation.indexOf('.') + 1))
      if (modules.length === 0) {
        unaccounted.push(`${operation} (no dispatch arm)`)
        continue
      }
      const resolving = modules.filter((name) => HANDLE_RESOLUTION.test(sources.get(name)!))
      if (resolving.length === 0) {
        continue
      }
      if (!resolving.some((name) => name in REAUTHORIZATION_SITES)) {
        unaccounted.push(`${operation} -> ${resolving.join(', ')}`)
      }
    }

    expect(unaccounted).toEqual([])
    expect(mutations()).toHaveLength(39)
  })

  it('exempts only registered mutations', () => {
    const registered = new Set(mutations())
    const exempt = [...NO_REAUTHORIZATION_WINDOW]

    expect(exempt.filter((operation) => !registered.has(operation))).toEqual([])
    expect(new Set(exempt).size).toBe(exempt.length)
  })

  it('classifies every registered operation with a kind', () => {
    const kinds = new Set(
      Object.values(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap((operations) => Object.values(operations))
    )
    const capabilities = Object.keys(MOBILE_WEB_BRIDGE_OPERATIONS) as MobileWebBridgeCapability[]

    expect([...kinds].sort()).toEqual(['mutation', 'read', 'subscription'])
    expect(capabilities).toHaveLength(9)
  })
})
