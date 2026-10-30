import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  isLegacyAgentSessionAccountHome,
  requireLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { structuredSlashCommands } from '../../shared/structured-agent-session-composer'
import { discoverSkills } from '../skills/discovery'
import { scanClaudeCommandFolders } from './claude-command-folder-scan'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'
import type { ClaudeCommandCatalogProbe } from './claude-command-catalog-probe'
import {
  AT_REST_COMMANDS_TTL_MS,
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { join } from 'node:path'

export const CLAUDE_AT_REST_COMMANDS_TTL_MS = AT_REST_COMMANDS_TTL_MS
// Each probe starts Claude; limit concurrent workspace discovery processes.
const MAX_PROBES_RUNNING = 2

export type ClaudeAtRestCommandsDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** A resting chat's next start follows the selected account, not the one it was created on. */
  resolveAccountHome?: () => Promise<AgentSessionAccountHome>
  probe?: ClaudeCommandCatalogProbe
  now?: () => number
  discover?: typeof discoverSkills
}

/** Probe Claude for at-rest commands; fall back to account/workspace command folders and skills. */
export class ClaudeAtRestCommandCatalog extends AtRestCommandCatalog {
  constructor(deps: ClaudeAtRestCommandsDeps) {
    const probes = new PrioritySemaphore(MAX_PROBES_RUNNING)
    super({
      label: 'claude',
      accepts: (record) =>
        record.provider === 'claude' &&
        supportsClaudeStructuredLocation(record.location) &&
        isLegacyAgentSessionAccountHome(record.accountHome),
      resolveWorkspacePath: deps.resolveWorkspacePath,
      ...(deps.resolveAccountHome ? { resolveAccountHome: deps.resolveAccountHome } : {}),
      scan: (record, cwd, isCurrent, _generation, signal, admitted) =>
        scanClaudeAtRest(deps, probes, record, cwd, isCurrent, signal, admitted),
      ...(deps.now ? { now: deps.now } : {})
    })
  }
}

async function scanClaudeAtRest(
  deps: ClaudeAtRestCommandsDeps,
  probes: PrioritySemaphore,
  record: AgentSessionRecord,
  cwd: string,
  isCurrent: () => boolean,
  signal: AbortSignal,
  admitted: () => void
): Promise<AtRestCommandScan> {
  const account = requireLegacyAgentSessionAccountHome(record.accountHome).path
  if (deps.probe) {
    const release = await probes.acquire(0, signal)
    try {
      if (!isCurrent()) {
        return { commands: undefined, fromAgent: false }
      }
      admitted()
      return {
        commands: await deps.probe({ cwd, accountHomePath: account, isCurrent, signal }),
        fromAgent: true
      }
    } catch (error) {
      if (!isCurrent()) {
        return { commands: undefined, fromAgent: false }
      }
      console.warn('[claude] listing the at-rest `/` commands failed; reading folders:', error)
    } finally {
      release()
    }
  }
  if (!isCurrent()) {
    return { commands: undefined, fromAgent: false }
  }
  admitted()
  const [custom, discovered] = await waitForPromiseWithSignal(
    Promise.all([
      scanClaudeCommandFolders(
        [join(cwd, '.claude', 'commands'), join(account, 'commands')],
        signal
      ),
      (deps.discover ?? discoverSkills)({
        signal,
        repos: [],
        cwd,
        providerRootOverrides: { claude: join(account, 'skills') }
      })
    ]),
    signal
  )
  // Older clients lack structuredSessionSlashCommands, so retain host built-ins in this list.
  const builtIn = structuredSlashCommands(['clear', 'compact'], 'claude').map(
    (command): AgentSessionSlashCommand => ({
      name: command.name,
      kind: 'command',
      ...(command.description ? { description: command.description } : {})
    })
  )
  const names = new Set(builtIn.map((command) => command.name))
  const skills = discovered.skills
    .filter((skill) => skill.providers.includes('claude'))
    .map((skill): AgentSessionSlashCommand => ({
      name: skill.name,
      kind: 'skill',
      ...(skill.description ? { description: skill.description } : {})
    }))
  return {
    commands: [...builtIn, ...custom.filter((command) => !names.has(command.name)), ...skills],
    fromAgent: false
  }
}
