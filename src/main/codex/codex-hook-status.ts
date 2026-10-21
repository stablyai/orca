import { existsSync, readFileSync } from 'node:fs'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { readHooksJson } from '../agent-hooks/installer-utils'
import {
  assertLoadableHookTrustConfig,
  isCodexConfigTomlRefusedError,
  readHookTrustEntries,
  readHookTrustKeySpellings,
  upsertHookTrustEntriesInContent,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  buildCodexManagedHook,
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import {
  approvalsAtOrcaEntries,
  findOrcaEntrySlots,
  getManagedCodexHookHome,
  isKnownOrcaHash,
  readKnownOrcaHashes,
  getRealHomeCodexHookHome,
  type CodexHookHome
} from './codex-hook-orca-approvals'
import type { CodexHookAnswer } from './codex-hook-trust-derivation'
import { readKnownCodexHookAnswer } from './codex-hook-hash-lookup'
import { resolveCodexHookStatusHome } from './codex-hook-reconcile'
import {
  getRealHomeHooksJsonPath,
  readRealHomeHooksFileProblem
} from './codex-real-home-hooks-json'

/**
 * Status for `runtimeHomePath`, or for the home the next native pane gets when
 * none is named (~/.codex outside the app), against what Codex last answered.
 */
export function readCurrentCodexHookStatus(runtimeHomePath?: string): AgentHookInstallStatus {
  const answer = readKnownCodexHookAnswer()
  if (runtimeHomePath !== undefined) {
    return readCodexHookHomeStatus(runtimeHomePath, answer)
  }
  const home = resolveCodexHookStatusHome()
  if (home.kind === 'unknown') {
    return {
      agent: 'codex',
      state: 'error',
      configPath: getRealHomeHooksJsonPath(),
      managedHooksPresent: false,
      detail: "The selected Codex account's home is not available yet"
    }
  }
  if (home.kind === 'real') {
    return readRealHomeCodexHookStatus(answer)
  }
  return readCodexHookHomeStatus(home.path, answer)
}

/** Status for a managed home, read from its files. */
export function readCodexHookHomeStatus(
  runtimeHomePath: string,
  answer: CodexHookAnswer | null
): AgentHookInstallStatus {
  return readHomeStatus(getManagedCodexHookHome(runtimeHomePath), answer)
}

/** Status for ~/.codex, under either spelling Codex keys it by. */
function readRealHomeCodexHookStatus(answer: CodexHookAnswer | null): AgentHookInstallStatus {
  const home = getRealHomeCodexHookHome()
  const problem = readRealHomeHooksFileProblem()
  if (problem) {
    return {
      agent: 'codex',
      state: 'error',
      configPath: home.hooksJsonPath,
      managedHooksPresent: false,
      detail: problem
    }
  }
  const status = readHomeStatus(home, answer)
  if (status.state === 'installed' || status.state === 'error') {
    return status
  }
  const inline = describeInlineApprovals(home, answer)
  return inline ? { ...status, detail: inline } : status
}

/**
 * Codex hook status for one home, read from its files: Orca's entry in each
 * event Codex lists, and that entry's approval holding Codex's own hash under
 * any spelling Codex may key the file by. Without Codex's answer, the reason.
 */
function readHomeStatus(
  home: CodexHookHome,
  answer: CodexHookAnswer | null
): AgentHookInstallStatus {
  const configPath = home.hooksJsonPath
  const command = getManagedCommand(getManagedScriptPath())
  const status = (
    state: AgentHookInstallState,
    managedHooksPresent: boolean,
    detail: string | null
  ): AgentHookInstallStatus => ({ agent: 'codex', state, configPath, managedHooksPresent, detail })
  const config = readHooksJson(configPath)
  if (!config) {
    return status('error', false, 'Could not parse Codex hooks.json')
  }
  const slots = findOrcaEntrySlots(config.hooks, command)
  // Why: an unreadable config.toml is distinct from an absent one (an empty map).
  let trustStates: ReadonlyMap<string, CodexHookTrustState>
  let spelled: (key: string) => boolean = () => false
  let trustReadError: string | null = null
  try {
    trustStates = readHookTrustEntries(home.tomlPath)
    spelled = readHookTrustKeySpellings(home.tomlPath)
  } catch (error) {
    trustStates = new Map()
    trustReadError = error instanceof Error ? error.message : String(error)
  }
  // Why every spelling: Codex on Windows ignores an approval kept only under the forward-slash key.
  const approvals = new Map(
    [...approvalsAtOrcaEntries(trustStates, slots, home.keySourcePaths, command)].map(
      ([eventLabel, held]) => [eventLabel, held.filter((approval) => spelled(approval.key))]
    )
  )
  if (answer?.kind !== 'hashes') {
    const reason = answer?.failure ?? 'Orca has not asked Codex yet'
    if (slots.size === 0) {
      return status('not_installed', false, reason)
    }
    if (answer?.kind === 'refused') {
      return status('partial', true, `Orca's hook entry is installed, but ${reason}`)
    }
    // Why not an error: until Codex answers, the approval is the home's earlier one or Orca's own hash.
    const known = readKnownOrcaHashes(home, command)
    const approved =
      trustReadError === null &&
      [...approvals].every(([eventLabel, held]) =>
        held.some(
          (approval) =>
            approval.enabled !== false && isKnownOrcaHash(known, eventLabel, approval.trustedHash)
        )
      )
    return approved
      ? status('installed', true, `Approved by Orca; not yet confirmed by Codex (${reason})`)
      : status('partial', true, `Orca's hook entry is not approved yet (${reason})`)
  }
  const listedEvents = CODEX_EVENTS.filter(
    (eventName) => answer.hashes[CODEX_EVENT_LABEL[eventName]] !== undefined
  )
  const missing: string[] = []
  const unapproved: string[] = []
  for (const eventName of listedEvents) {
    const label = CODEX_EVENT_LABEL[eventName]
    const hash = answer.hashes[label]
    if (!slots.has(eventName)) {
      missing.push(eventName)
      continue
    }
    // Why null passes: that Codex lists the entry with no hash, so it runs unapproved.
    if (hash === null) {
      continue
    }
    const approved = approvals
      .get(label)
      ?.some((approval) => approval.trustedHash === hash && approval.enabled !== false)
    if (trustReadError === null && !approved) {
      unapproved.push(eventName)
    }
  }
  if (missing.length === listedEvents.length) {
    return status(
      'not_installed',
      false,
      trustReadError && `Trust entries unverifiable: ${trustReadError}`
    )
  }
  const parts = [
    missing.length > 0 ? `Managed hook missing for events: ${missing.join(', ')}` : null,
    trustReadError !== null
      ? `Trust entries unverifiable: ${trustReadError}`
      : unapproved.length > 0
        ? `Approval missing, stale or disabled for events: ${unapproved.join(', ')}`
        : null
  ].filter((part): part is string => part !== null)
  return parts.length === 0
    ? status('installed', true, null)
    : status('partial', true, parts.join('; '))
}

/**
 * Why Orca's approvals are missing, when it is config.toml's inline approvals:
 * adding Orca's own there would leave a file Codex cannot load. Read now.
 */
function describeInlineApprovals(
  home: CodexHookHome,
  answer: CodexHookAnswer | null
): string | null {
  if (!existsSync(home.tomlPath)) {
    return null
  }
  const command = getManagedCommand(getManagedScriptPath())
  const hooks = readHooksJson(home.hooksJsonPath)?.hooks
  const slots = findOrcaEntrySlots(hooks, command)
  const probes: CodexTrustEntry[] = CODEX_EVENTS.flatMap((eventName) => {
    const label = CODEX_EVENT_LABEL[eventName]
    const hash = answer?.kind === 'hashes' ? answer.hashes[label] : 'probe'
    const definitions = hooks?.[eventName]
    const slot = slots.get(eventName) ?? {
      groupIndex: Array.isArray(definitions) ? definitions.length : 0,
      handlerIndex: 0
    }
    return typeof hash === 'string'
      ? [
          {
            sourcePath: home.keySourcePaths[0],
            eventLabel: label,
            command,
            timeoutSec: buildCodexManagedHook(command, eventName).timeout,
            trustedHash: hash,
            enabled: true,
            ...slot
          }
        ]
      : []
  })
  try {
    const previous = readFileSync(home.tomlPath, 'utf-8')
    assertLoadableHookTrustConfig(
      home.tomlPath,
      previous,
      upsertHookTrustEntriesInContent(previous, probes)
    )
    return null
  } catch (error) {
    return isCodexConfigTomlRefusedError(error)
      ? `${home.tomlPath} keeps hook approvals inline, so Orca cannot add its own there; Orca shows no status for ~/.codex until they are tables`
      : null
  }
}
