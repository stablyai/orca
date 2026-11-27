import { describe, expect, it } from 'vitest'
import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
import { claudeStructuredPermissionOptions } from '../structured/launch/claude-structured-permission-options'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import {
  CLAUDE_RELAY_KEEP,
  claudeRelayKeepFor,
  feedClaudeKeptModeLines
} from './claude-relay-kept-mode'
import { requiresAcquisition } from './claude-kept-permission'

const LAUNCHES: AgentChatPermissionChoice[] = ['own', 'ask', 'accept-edits', 'auto', 'full-access']
const MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']

/** The CLI arguments a launch choice puts on Claude's command line (the SDK's flag forms). */
function launchArgs(choice: AgentChatPermissionChoice): string[] {
  const options = claudeStructuredPermissionOptions(choice)
  const extra = Object.keys(options.extraArgs ?? {}).map((flag) => `--${flag}`)
  return options.permissionMode ? [...extra, `--permission-mode=${options.permissionMode}`] : extra
}

/** A reattach of an agent launched with `choice` whose settings default is `settings`, after the
 *  mode reports `reports`, as the daemon hands it back. */
function reattach(choice: AgentChatPermissionChoice, settings: string, reports: string[]) {
  const launched = claudeStructuredPermissionOptions(choice).permissionMode
  const init =
    choice === 'own' ? settings : choice === 'full-access' ? 'bypassPermissions' : launched
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', permissionMode: init }),
    ...reports.map((mode) =>
      JSON.stringify({ type: 'system', subtype: 'status', status: null, permissionMode: mode })
    )
  ]
  const [initMarker, reportMarker] = CLAUDE_RELAY_KEEP.lines
  const kept = lines.map((_, index) => ({
    name: `l:${index === 0 ? initMarker : reportMarker}`,
    seq: index + 1
  }))
  // The daemon keeps only the latest line per marker.
  const latest = kept.filter((_, index) => index === 0 || index === kept.length - 1)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader uses only attachResult and kept
  const child = {
    attachResult: { kept: latest, launchNote: claudeRelayKeepFor(launchArgs(choice)).note },
    kept: { lines: new Map(kept.map(({ seq }) => [seq, lines[seq - 1]])), drop: () => {} }
  } as unknown as RelayedProviderChild
  const mode = feedClaudeKeptModeLines(child, undefined)
  return { mode, current: reports.at(-1) ?? init }
}

function sequences(length: number): string[][] {
  return length === 0
    ? [[]]
    : sequences(length - 1).flatMap((head) => MODES.map((m) => [...head, m]))
}

describe('a kept Claude agent and "your Claude settings"', () => {
  it('keeps the agent only when it runs the mode its own settings gave it, else owes a fresh one', () => {
    for (const choice of LAUNCHES) {
      for (const settings of ['default', 'acceptEdits', 'bypassPermissions']) {
        for (const reports of [0, 1, 2].flatMap(sequences)) {
          for (const permissionPick of [undefined, 1]) {
            const { mode, current } = reattach(choice, settings, reports)
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only these fields
            const session = {
              connection: { kept: { ownSettings: mode.ownSettings } },
              permissionPick
            } as unknown as ClaudeSession
            const owed = requiresAcquisition(new Map([['s', session]]))('s', 'own')
            const matches = choice === 'own' && permissionPick === undefined && current === settings
            expect(
              owed === true,
              `${choice} ${settings} [${reports.join(',')}] ${String(permissionPick)}`
            ).toBe(!matches)
          }
        }
      }
    }
  })
})
