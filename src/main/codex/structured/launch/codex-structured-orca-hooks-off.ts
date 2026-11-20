import { createManagedCommandMatcher } from '../../../agent-hooks/installation/commands/managed-hook-command-matching'
import { readHooksJson } from '../../../agent-hooks/installation/configuration/hooks-json-read'
import { escapeTomlBasicString } from '../../configuration/toml/config-toml-syntax'
import {
  createCodexHookTrustEntry,
  getCodexManagedScriptFileName
} from '../../hooks/definitions/codex-hook-identity'
import { getInPlaceCodexHookHome } from '../../trust/hooks/codex-hook-orca-approvals'
import { computeCodexTrustKey } from '../../trust/identity/codex-trust-identity'

/**
 * Chat strips pane env, so Orca's status hooks only cost a spawn per event, and under Store
 * PowerShell every spawn fails (openai/codex#47810). Disable Orca's entries, including older
 * forms the installer keeps, for this launch. One inline table because Codex splits `-c` keys
 * on every dot, including the one in hooks.json.
 */
export function codexOrcaHooksOffArgs(codexHomePath: string): string[] {
  const home = getInPlaceCodexHookHome(codexHomePath)
  const isOrcaCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const hooks = readHooksJson(home.hooksJsonPath)?.hooks ?? {}
  // hooks.json is user-editable; skip malformed groups and handlers as Codex does.
  const entries = Object.entries(hooks).flatMap(([eventName, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group, groupIndex) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).flatMap((hook, handlerIndex) =>
        hook && isOrcaCommand(hook.command)
          ? home.keySourcePaths.flatMap((sourcePath) => {
              const entry = createCodexHookTrustEntry(
                sourcePath,
                eventName,
                groupIndex,
                handlerIndex,
                group,
                hook
              )
              return entry
                ? [`"${escapeTomlBasicString(computeCodexTrustKey(entry))}"={enabled=false}`]
                : []
            })
          : []
      )
    )
  )
  return entries.length > 0 ? ['-c', `hooks.state={${entries.join(',')}}`] : []
}
