/**
 * R42: during the move to WSL hosts, the WSL bridge (installing from Windows) and the distro's own
 * orcad (installing locally) both reconcile Claude's hooks in the distro's ~/.claude. Both write
 * the one shared entry, so in either order the file ends with exactly one Orca entry per event,
 * and the user's own hooks survive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClaudeManagedHookPlan } from './claude-managed-hook-events'
import { buildManagedCommandHook, type HooksConfig } from '../agent-hooks/installer-utils'
import {
  applyManagedHooks,
  getManagedEventHook,
  getPosixManagedScriptFileName,
  getRemoteManagedEventCommand
} from './hook-settings'

const HOME = '/home/dev'
const SCRIPT = `${HOME}/.orca/agent-hooks/${getPosixManagedScriptFileName()}`
const plan = getClaudeManagedHookPlan(null)
const userHook = { matcher: '', hooks: [{ type: 'command' as const, command: 'notify-send done' }] }

const originalPlatform = process.platform
beforeEach(() => {
  // orcad runs inside the distro: the local installer takes its Linux form.
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

const byHost = (config: HooksConfig): HooksConfig =>
  applyManagedHooks(
    config,
    (event) => getManagedEventHook(event, SCRIPT),
    getPosixManagedScriptFileName(),
    plan
  )
const byBridge = (config: HooksConfig): HooksConfig =>
  applyManagedHooks(
    config,
    (event) => buildManagedCommandHook(getRemoteManagedEventCommand(event, SCRIPT)),
    getPosixManagedScriptFileName(),
    plan
  )

describe('Claude hooks written by the WSL bridge and the WSL host in one home', () => {
  it.each([
    ['bridge then host', [byBridge, byHost]],
    ['host then bridge', [byHost, byBridge]]
  ] as const)('%s: one Orca entry per event, the user hook kept', (_order, writers) => {
    const start: HooksConfig = { hooks: { Stop: [userHook] } }
    const after = writers.reduce((config, write) => write(config), start)

    for (const { eventName } of plan.install) {
      const commands = (after.hooks?.[eventName] ?? []).flatMap((entry) =>
        (entry.hooks ?? []).map((hook) => hook.command)
      )
      expect(
        commands.filter((command) => command.includes('agent-hooks/')),
        eventName
      ).toHaveLength(1)
    }
    expect(after.hooks?.Stop).toContainEqual(userHook)
    // Each side rewrites the other's entry to the same bytes: no flapping between the two.
    expect(byHost(after)).toEqual(after)
    expect(byBridge(after)).toEqual(after)
  })
})
