import {
  removeManagedCommands,
  type HookCommandConfig,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  buildCodexManagedHook,
  CODEX_EVENT_LABEL,
  type CodexManagedHookInstallMaterial
} from './codex-hook-definition'
import { CODEX_HOOK_COMMAND_FORM, readCodexHookCommandForm } from './codex-hook-command-form'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import type { CodexEventLabel, CodexTrustEntry } from './config-toml-trust'

type HooksByEvent = Record<string, HookDefinition[]>

/**
 * Orca's entry in ~/.codex lives alone, in a group with no matcher, once per
 * event: Codex hashes the group's matcher, so a copy inside a user's group
 * would wait for review forever.
 */
export type RealHomeCodexHookEntryPlan =
  /** Drop every Orca copy but the one kept first: user hooks may shift, so their approvals move. */
  | { kind: 'prune'; hooks: HooksByEvent }
  | {
      kind: 'settle'
      /** Orca's entry rewritten in place or appended last; no user hook moves. */
      hooks: HooksByEvent
      /** Events whose hooks this plan changed; an approval read before the write may no longer fit them. */
      changedLabels: ReadonlySet<CodexEventLabel>
      /** Orca's entry in each planned event, keyed by `sourcePath`. */
      managedEntries: CodexTrustEntry[]
      /** Events left as they are: a newer build's entry, or an older one not up for conversion. */
      untouchedLabels: ReadonlySet<CodexEventLabel>
    }

type OrcaHandler = {
  groupIndex: number
  hook: HookCommandConfig
  form: number
}

function findOrcaHandlers(
  definitions: HookDefinition[],
  isOrcaCommand: (command: string | undefined) => boolean,
  command: string
): OrcaHandler[] {
  return definitions.flatMap((definition, groupIndex) =>
    Array.isArray(definition.hooks)
      ? definition.hooks.flatMap((hook) =>
          isOrcaCommand(hook.command)
            ? [{ groupIndex, hook, form: readCodexHookCommandForm(hook.command, command) }]
            : []
        )
      : []
  )
}

/** A group that holds only Orca's handlers, with no matcher and nothing else of the user's. */
function isOrcaOnlyGroup(
  definition: HookDefinition,
  isOrcaCommand: (command: string | undefined) => boolean
): boolean {
  return (
    Object.keys(definition).every((key) => key === 'hooks') &&
    Array.isArray(definition.hooks) &&
    definition.hooks.every((hook) => isOrcaCommand(hook.command))
  )
}

// Why every field: Codex hashes command, type, timeout, async and statusMessage, so an
// edited copy kept in place would sit beside an approval for what Orca wrote.
function isSameHook(left: HookCommandConfig, right: HookCommandConfig): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]))
}

function isSameList(left: HookDefinition[], right: HookDefinition[]): boolean {
  return (
    left.length === right.length && left.every((definition, index) => definition === right[index])
  )
}

export function planRealHomeCodexHookEntries(args: {
  hooks: HooksByEvent
  sourcePath: string
  material: Pick<CodexManagedHookInstallMaterial, 'events' | 'command'>
  isOrcaCommand: (command: string | undefined) => boolean
  /** App start and the setting turning on; a launch never fights a running older build. */
  convertOlderForms: boolean
}): RealHomeCodexHookEntryPlan {
  const { material, isOrcaCommand, sourcePath } = args
  const command = material.command
  // Why: events this build does not plan keep their Orca entries; a newer build
  // may subscribe to them, and Codex lists no hash for them here.
  const pruned: HooksByEvent = { ...args.hooks }
  const hooks: HooksByEvent = { ...args.hooks }
  const changedLabels = new Set<CodexEventLabel>()
  const untouchedLabels = new Set<CodexEventLabel>()
  const managedEntries: CodexTrustEntry[] = []
  let prunedChanged = false

  for (const eventName of material.events) {
    const label = CODEX_EVENT_LABEL[eventName]
    const current = Array.isArray(args.hooks[eventName]) ? args.hooks[eventName] : []
    const handlers = findOrcaHandlers(current, isOrcaCommand, command)
    const holdsOlderForm =
      current.some((definition) =>
        [definition.command, definition.bash, definition.powershell].some(isOrcaCommand)
      ) || handlers.some((handler) => handler.hook.command !== command)
    if (
      handlers.some((handler) => handler.form > CODEX_HOOK_COMMAND_FORM) ||
      (holdsOlderForm && !args.convertOlderForms)
    ) {
      // Why: a newer build owns this event's entry, and an older build's may still be running.
      untouchedLabels.add(label)
      continue
    }
    const keeper = handlers.find((handler) =>
      isOrcaOnlyGroup(current[handler.groupIndex]!, isOrcaCommand)
    )
    const rest = removeManagedCommands(current, isOrcaCommand)
    // Why the kept group where its copies were: the slot keeps its position, so no user approval key moves.
    const slot = keeper
      ? removeManagedCommands(current.slice(0, keeper.groupIndex), isOrcaCommand).length
      : rest.length
    const keptGroup = keeper && current[keeper.groupIndex]!
    const prunedDefinitions = keptGroup
      ? [
          ...rest.slice(0, slot),
          keptGroup.hooks!.length === 1 ? keptGroup : { hooks: [keeper.hook] },
          ...rest.slice(slot)
        ]
      : rest
    if (!isSameList(prunedDefinitions, current)) {
      pruned[eventName] = prunedDefinitions
      prunedChanged = true
      continue
    }
    const wanted = buildCodexManagedHook(command, eventName)
    // Why last when new: no user hook's positional approval key moves.
    const definitions =
      keeper && isSameHook(keeper.hook, wanted)
        ? current
        : [...current.slice(0, slot), { hooks: [wanted] }, ...current.slice(slot + 1)]
    if (definitions !== current) {
      hooks[eventName] = definitions
      changedLabels.add(label)
    }
    const entry = createCodexHookTrustEntry(
      sourcePath,
      eventName,
      slot,
      0,
      definitions[slot]!,
      definitions[slot]!.hooks![0]!
    )
    if (entry) {
      managedEntries.push(entry)
    }
  }

  return prunedChanged
    ? { kind: 'prune', hooks: pruned }
    : { kind: 'settle', hooks, changedLabels, managedEntries, untouchedLabels }
}
