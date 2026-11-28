// The census of teammate-rules.ts: every RPC method is classified for teammates, and the host's tab
// list and window each have one write point, so a new method or writer can't reach a teammate (or
// the owner's list) without a decision.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { TEAMMATE_METHOD_CLASS_TABLE, TEAMMATE_METHOD_CLASSES } from './teammate-rules'
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
    // A launch names its workspace in `target`, read as `target.worktree`.
    const target = 'target' in schema.shape ? schema.shape.target : undefined
    return [
      ...Object.keys(schema.shape),
      ...(target ? paramKeys(target).map((key) => `target.${key}`) : [])
    ]
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

  it('reads the workspace of every host-list writer it refuses early in a teammate’s Home', () => {
    // A chats-only teammate reaches none of them; the workspace tier's call names its workspace
    // (`worktree`, or a launch's `target.worktree`). One naming none is refused at admission.
    for (const name of hostList) {
      const method = byName.get(name)!
      expect(method.share, name).toBe('not-shared')
      expect(
        paramKeys(method.params).filter((key) => ['worktree', 'target.worktree'].includes(key)),
        name
      ).not.toEqual([])
    }
  })

  it('names the person of every Home tab write from the caller’s scope or the chat’s stamp', () => {
    const src = join(import.meta.dirname, '../..')
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter(
        (file) => file.endsWith('.ts') && !/\.test\.|fixture|test-support|test-harness/.test(file)
      )
      .map((file) => ({
        file: file.replaceAll('\\', '/'),
        text: readFileSync(join(src, file), 'utf8')
      }))
    // The Home tab write API: each takes the person (`person`, `personOf` or `people`) as a required field.
    const writes =
      /\b(publishStructuredAgentSessionTab|activateMobileSessionTab|closeMobileSessionTab|refuseUnattributedMobileSessionTabClose|closeChatTabs|commitStructuredAgentSessionCreate|createMobileSessionTerminal|createSessionBrowserTab|openPersonFile)\(/g
    // Sources: the caller's scope at a handler, a chat's stamp, the host's own state, the list a close
    // names (`sessionTabCloseTarget`, which reads one of those); or the field of a function that took
    // one of those (its own callers are in this census too).
    const source =
      /^(callerTabPerson\(\w+\.callerScope\)|closeTarget\.person|callerTabPerson\(callerScope\)|\(?\w*\)? => callerTabPerson\(ctx\.callerScope\)|(\w+\.)?runtime\.chatTab(Person|People)\(|(\(\w+\) => )?args\.runtime\.chatTabPerson\(|HOST_STATE_PERSON|args\.personOf\(|input\.person|options\.person|opts\.person|caller\.person)/
    const calls = files.flatMap(({ file, text }) =>
      [...text.matchAll(writes)].flatMap((match) => {
        const at = match.index + match[0].length
        // A declaration (`name(` after `async`, a method head) names no person.
        const head = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index)
        if (/^\s*(async |protected |private |public )*$/.test(head) || /function\s+$/.test(head)) {
          return []
        }
        let depth = 1
        let end = at
        while (depth > 0 && end < text.length) {
          depth += text[end] === '(' ? 1 : text[end] === ')' ? -1 : 0
          end += 1
        }
        const call = text.slice(at, end)
        const named =
          /\b(?:person|personOf|people): \[?([^,\n}\]]+)/.exec(call)?.[1]?.trim() ?? '(none)'
        return [{ at: `${file} ${match[1]}`, named }]
      })
    )
    expect(calls.length).toBeGreaterThan(10)
    expect(calls.filter((call) => !source.test(call.named))).toEqual([])
    // A `closeTarget` is only ever the one close resolver's.
    expect(
      files
        .filter(
          ({ text }) =>
            text.includes('closeTarget.person') &&
            !text.includes('const closeTarget = await sessionTabCloseTarget(')
        )
        .map(({ file }) => file)
    ).toEqual([])
    // The host's own state names only the host's terminals' tabs.
    expect(
      calls.filter(
        (call) =>
          call.named === 'HOST_STATE_PERSON' &&
          !call.at.includes('session-tabs/terminal-retirement/')
      )
    ).toEqual([])
    // No ambient person: no async-context scope, and no write point that throws on one.
    const ambient =
      /getActiveTeammate|runWithActiveTeammate|TeammateHostTabWriteError|admitWritesBy/
    expect(files.filter(({ text }) => ambient.test(text)).map(({ file }) => file)).toEqual([])
  })
})
