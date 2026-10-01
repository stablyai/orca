import {
  readHooksJsonWithRaw,
  writeHooksJson,
  type HookCommandConfig,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import type { RealHomeCodexHookSlotWrite } from './codex-real-home-hook-entry-plan'
import {
  assertHooksJsonGeneration,
  getRealHomeConfigTomlPath,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import { readHookTrustEntries } from './config-toml-trust'
import { readOrcaEntryTrust } from './codex-real-home-entry-trust'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-moves'

function withdrawHandler(
  definitions: HookDefinition[],
  location: { groupIndex: number; handlerIndex: number },
  replaced: HookCommandConfig | null
): HookDefinition[] {
  const definition = definitions[location.groupIndex]!
  const hooks = [...definition.hooks!]
  if (replaced) {
    hooks[location.handlerIndex] = replaced
  } else {
    hooks.splice(location.handlerIndex, 1)
  }
  const next = [...definitions]
  if (hooks.length === 0) {
    next.splice(location.groupIndex, 1)
  } else {
    next[location.groupIndex] = { ...definition, hooks }
  }
  return next
}

/**
 * After a failed trust grant: takes back each entry this call wrote that is still
 * untrusted, putting back the handler it replaced. Re-reads both files, so a
 * concurrent edit, or the identical entry another Orca trusted, survives.
 */
export function withdrawUntrustedRealHomeWrites(
  writes: readonly RealHomeCodexHookSlotWrite[],
  command: string
): number {
  if (writes.length === 0) {
    return 0
  }
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config?.hooks) {
    return 0
  }
  const trustStates = readHookTrustEntries(getRealHomeConfigTomlPath())
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  let withdrew = 0
  for (const { eventName, replaced, ...location } of writes) {
    const definitions = nextHooks[eventName]
    const definition = Array.isArray(definitions) ? definitions[location.groupIndex] : undefined
    const handler = Array.isArray(definition?.hooks)
      ? definition.hooks[location.handlerIndex]
      : undefined
    // Why: a copy that moved is not provably this call's; the next launch's grant retries it.
    if (!definitions || !definition || handler?.command !== command) {
      continue
    }
    const entry = createCodexHookTrustEntry(
      hooksJsonPath,
      eventName,
      location.groupIndex,
      location.handlerIndex,
      definition,
      handler
    )
    const trust = entry ? readOrcaEntryTrust(entry, trustStates) : 'untrusted'
    if (trust === 'trusted' || trust === 'disabled') {
      continue
    }
    const next = withdrawHandler(definitions, location, replaced)
    if (next.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = next
    }
    withdrew += 1
  }
  if (withdrew > 0) {
    // Why: a hook appended after this entry meanwhile moves up a slot; its trust moves with it.
    mutateRealHomeHooksPreservingUserTrust({
      sourcePath: hooksJsonPath,
      tomlPath: getRealHomeConfigTomlPath(),
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
        writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
      }
    })
  }
  return withdrew
}
