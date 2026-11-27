// The census of teammate-rules.ts: every RPC method and every host tab writer is classified for
// teammates, so a new one can't reach a teammate (or the owner's list) without a decision.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import {
  TEAMMATE_METHOD_CLASS_TABLE,
  TEAMMATE_METHOD_CLASSES,
  TEAMMATE_TAB_WRITES
} from './teammate-rules'
import { TEAMMATE_HANDLER_FILTERED, TEAMMATE_LISTED_METHODS } from './teammate-workspace-lists'
import { TEAMMATE_CLIENT_EVENT_DECISIONS } from './teammate-client-events'

const classified = TEAMMATE_METHOD_CLASSES.flatMap((kind) =>
  TEAMMATE_METHOD_CLASS_TABLE[kind].map((name: string) => ({ name, kind }))
)
const classOf = new Map<string, string>(classified.map((entry) => [entry.name, entry.kind]))

describe('the workspace tier’s method table', () => {
  it('classifies every registered method exactly once, and nothing else', () => {
    const registered: string[] = ALL_RPC_METHODS.map((method) => method.name)
    const unclassified = registered.filter((name) => !classOf.has(name))
    expect(unclassified, 'classify these in teammate-method-classes.json').toEqual([])
    expect(classified.length).toBe(classOf.size)
    expect([...classOf.keys()].filter((name) => !registered.includes(name))).toEqual([])
  })

  it('keeps every method a chats-only teammate already has', () => {
    const lost = ALL_RPC_METHODS.filter(
      (method) => method.share !== 'not-shared' && classOf.get(method.name) === 'refused'
    ).map((method) => method.name)
    expect(lost).toEqual([])
  })

  it('admits no settings, accounts, skills, host, pairing or desktop method beyond today’s share', () => {
    const admittedAdmin = ALL_RPC_METHODS.filter(
      (method) =>
        classOf.get(method.name) !== 'refused' &&
        method.share === 'not-shared' &&
        method.permission !== 'workspace' &&
        method.permission !== 'device-self'
    ).map((method) => method.name)
    // A teammate's own pages send their network through the host, bound to their own lease.
    expect(admittedAdmin).toEqual(['network.browserTunnel'])
  })

  it('filters every filtered method somewhere, and classifies every filter as filtered', () => {
    const filters = new Set([...TEAMMATE_LISTED_METHODS, ...TEAMMATE_HANDLER_FILTERED])
    const filtered: readonly string[] = TEAMMATE_METHOD_CLASS_TABLE.filtered
    expect(filtered.filter((name) => !filters.has(name))).toEqual([])
    expect([...filters].filter((name) => classOf.get(name) !== 'filtered')).toEqual([])
  })

  it('drops the host’s own client events, as the design lists them', () => {
    const dropped = Object.entries(TEAMMATE_CLIENT_EVENT_DECISIONS)
      .filter(([, decision]) => decision === 'drop')
      .map(([type]) => type)
      .sort()
    expect(dropped).toEqual(
      [
        'activateWorktree',
        'agentCliUpdateFinished',
        'automationsChanged',
        'browserProfilesChanged',
        'mcpServersChanged',
        'nativeChatLaunchDraftResolved',
        'notificationAttentionAcknowledged',
        'peerMailReturned',
        'relayHostRowsChanged',
        'relayHostsChanged',
        'settingsChanged',
        'sidebarInputsChanged',
        'sshStateChanged',
        'workspaceCleanupRunFinished',
        'workspaceViewChanged'
      ].sort()
    )
  })

  it('classifies the host-window effect of every method a teammate can reach, exactly once', () => {
    // Either tier: the workspace tier's classes, or a chats-only teammate's shared methods.
    const reachable = ALL_RPC_METHODS.filter(
      (method) => classOf.get(method.name) !== 'refused' || method.share !== 'not-shared'
    ).map((method): string => method.name)
    const { refused, none, conditional } = TEAMMATE_METHOD_CLASS_TABLE.hostWindow
    const listed: string[] = [...refused, ...none, ...Object.values(conditional).flat()]
    expect(listed.filter((name, index) => listed.indexOf(name) !== index)).toEqual([])
    const unlisted = reachable.filter((name) => !listed.includes(name))
    expect(unlisted, 'classify these under hostWindow in teammate-method-classes.json').toEqual([])
    expect(listed.filter((name) => !reachable.includes(name))).toEqual([])
  })
})

/** The keys a method's params schema names, through unions, wrappers and lazy schemas. */
function paramKeys(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null) {
    return []
  }
  if ('shape' in schema && typeof schema.shape === 'object' && schema.shape !== null) {
    return Object.keys(schema.shape)
  }
  const def = 'def' in schema && typeof schema.def === 'object' ? schema.def : null
  if (!def) {
    return []
  }
  return Object.entries(def).flatMap(([key, value]) =>
    key === 'options' && Array.isArray(value)
      ? value.flatMap(paramKeys)
      : ['in', 'innerType', 'left', 'right', 'schema'].includes(key)
        ? paramKeys(value)
        : []
  )
}

describe('a teammate’s own Home tab list (rule 4)', () => {
  const { person, hostList, none } = TEAMMATE_METHOD_CLASS_TABLE.homeTabs
  const byName = new Map<string, (typeof ALL_RPC_METHODS)[number]>(
    ALL_RPC_METHODS.map((method) => [method.name, method])
  )

  it('classifies every session.tabs method a teammate reaches, and nothing else twice', () => {
    const named = [...person, ...hostList, ...none]
    expect(named.filter((name, index) => named.indexOf(name) !== index)).toEqual([])
    expect(named.filter((name) => !byName.has(name))).toEqual([])
    const unclassified = ALL_RPC_METHODS.filter(
      (method) =>
        method.name.startsWith('session.tabs.') &&
        classOf.get(method.name) !== 'refused' &&
        !named.includes(method.name)
    ).map((method) => method.name)
    expect(unclassified, 'classify these under homeTabs in teammate-method-classes.json').toEqual(
      []
    )
  })

  it('reads the workspace of every host-list writer it refuses in a teammate’s Home', () => {
    // A chats-only teammate reaches none of them; the workspace tier's call names its workspace.
    for (const name of hostList) {
      const method = byName.get(name)!
      expect(method.share, name).toBe('not-shared')
      expect(paramKeys(method.params), name).toContain('worktree')
    }
  })

  it('classifies every file that writes a host tab list or publishes a chat tab', () => {
    const src = join(import.meta.dirname, '../../..')
    const writes =
      /mobileSessionTabsByWorktree\.set\(|storeMobileSessionSnapshot\(|publishStructuredAgentSessionTab\(|projectStructuredAgentSessionTab\(|projectStructuredSessionTab\(/
    const writers = readdirSync(join(src, 'main'), { recursive: true, encoding: 'utf8' })
      .filter(
        (file) =>
          file.endsWith('.ts') && !/\.test\.|test-fixture|test-support|test-harness/.test(file)
      )
      .filter((file) => writes.test(readFileSync(join(src, 'main', file), 'utf8')))
      .map((file) => relative(join(src, '..'), join(src, 'main', file)).replaceAll('\\', '/'))
      .sort()
    expect(writers, 'classify these in TEAMMATE_TAB_WRITES (teammate-rules.ts)').toEqual(
      Object.keys(TEAMMATE_TAB_WRITES).sort()
    )
    // A routed writer publishes through the one chat tab write, which asks `tabOwnerOf` first.
    for (const [file, verdict] of Object.entries(TEAMMATE_TAB_WRITES)) {
      if (verdict === 'routed') {
        expect(readFileSync(join(src, '..', file), 'utf8'), file).toMatch(
          /publishStructuredAgentSessionTab\(/
        )
      }
    }
    const publish = readFileSync(
      join(src, 'main/runtime/session-tabs/chat/structured-session-tab-restoration.ts'),
      'utf8'
    )
    expect(publish).toMatch(
      /publishStructuredAgentSessionTab\([^)]*\)[^{]*\{\s*input\.workspaceAuthority\?\.check\(\)[^]*?if \(await this\.publishCallerPersonChatTab\(input\)\)/
    )
  })
})
