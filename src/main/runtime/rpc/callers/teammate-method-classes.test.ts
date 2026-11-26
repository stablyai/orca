import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../methods/rpc-method-registry'
import { TEAMMATE_METHOD_CLASS_TABLE } from './teammate-method-classes'
import {
  TEAMMATE_HANDLER_FILTERED,
  TEAMMATE_LISTED_METHODS
} from '../../../bots/team-share/teammate-workspace-lists'
import { TEAMMATE_CLIENT_EVENT_DECISIONS } from '../../../bots/team-share/teammate-client-events'
import {
  TEAMMATE_HOST_FACT_METHODS,
  TEAMMATE_TARGET_PARAMS
} from '../../../bots/team-share/teammate-call-targets'

const classified = Object.entries(TEAMMATE_METHOD_CLASS_TABLE).flatMap(([kind, names]) =>
  names.map((name: string) => ({ name, kind }))
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

  it('names a target in every scoped method’s params, or reads only host facts', () => {
    const untargeted = ALL_RPC_METHODS.filter((method) => {
      const shape = method.params && 'shape' in method.params ? method.params.shape : null
      return (
        classOf.get(method.name) === 'scoped' &&
        // A shared method keeps its own share check (its bot, its chat).
        method.share === 'not-shared' &&
        shape !== null &&
        typeof shape === 'object' &&
        !Object.keys(shape).some((key) => TEAMMATE_TARGET_PARAMS.has(key)) &&
        !TEAMMATE_HOST_FACT_METHODS.has(method.name)
      )
    }).map((method) => method.name)
    expect(untargeted).toEqual([])
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
        'relayHostsChanged',
        'settingsChanged',
        'sidebarInputsChanged',
        'sshStateChanged',
        'workspaceCleanupRunFinished',
        'workspaceViewChanged'
      ].sort()
    )
  })
})
