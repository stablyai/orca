import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  buildManagedCommandHook,
  removeManagedCommands,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { getSystemCodexHomePath } from './codex-home-paths'

/** The user's real `~/.codex` hook files, plus the guards and rollback the
 *  real-home lane needs before it is allowed to mutate them. */
export function getRealHomeHooksJsonPath(): string {
  return join(getSystemCodexHomePath(), 'hooks.json')
}

export function getRealHomeConfigTomlPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

/** Orca-side state dir; nothing extra is ever written into the user's ~/.codex. */
function getRealHomeHookStateDir(userDataPath: string): string {
  return join(userDataPath, 'codex-real-home-hooks')
}

export function assertHooksJsonGeneration(
  hooksJsonPath: string,
  hooksWritePath: string,
  expectedRaw: string | null
): void {
  const currentRaw = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, 'utf-8') : null
  if (currentRaw !== expectedRaw || resolveHooksJsonWritePath(hooksJsonPath) !== hooksWritePath) {
    // Why: the pre-mutation RPC can overlap a user's editor save. Abort rather
    // than atomically replacing a newer file with the stale parsed snapshot.
    throw new Error('Codex hooks.json changed while Orca prepared its trust repair')
  }
}

/** One-time pristine copy of the user's file, kept under Orca's userData. */
export function backupRealHomeHooksJsonOnce(
  userDataPath: string,
  previousRaw: string | null
): void {
  if (previousRaw === null) {
    return
  }
  const backupDir = getRealHomeHookStateDir(userDataPath)
  const backupPath = join(backupDir, 'hooks.json.pre-orca')
  if (existsSync(backupPath)) {
    return
  }
  // Why: this lane mutates the user's real Codex home. If the required
  // pristine recovery copy cannot be created, keep the managed lane intact.
  mkdirSync(backupDir, { recursive: true })
  writeFileAtomically(backupPath, previousRaw, { mode: 0o600 })
}

export function restoreRealHomeHooksJson(
  hooksJsonPath: string,
  previousRaw: string | null,
  previousMode?: number
): void {
  if (previousRaw === null) {
    if (existsSync(hooksJsonPath)) {
      unlinkSync(hooksJsonPath)
    }
    return
  }
  // Why: rollback is part of the safety boundary. Use the shared atomic
  // writer so Windows file-lock retries and failed-temp cleanup are covered.
  writeFileAtomically(hooksJsonPath, previousRaw, { mode: previousMode })
}

/** Places Orca's managed hook in `definitions`, reusing its existing slot when
 *  one is unambiguous so no later user trust position shifts. */
export function reconcileManagedHookDefinition(
  current: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean,
  command: string
): { definitions: HookDefinition[]; groupIndex: number; handlerIndex: number } {
  const directCommandKeys = ['command', 'bash', 'powershell'] as const
  const hasManagedDirectCommand = current.some((definition) =>
    directCommandKeys.some((key) => isManagedCommand(definition[key]))
  )
  const nestedLocations = current.flatMap((definition, groupIndex) =>
    Array.isArray(definition.hooks)
      ? definition.hooks.flatMap((hook, handlerIndex) =>
          isManagedCommand(hook.command) ? [{ groupIndex, handlerIndex }] : []
        )
      : []
  )
  if (!hasManagedDirectCommand && nestedLocations.length === 1) {
    const { groupIndex, handlerIndex } = nestedLocations[0]!
    const definition = current[groupIndex]!
    const hasDirectCommand = directCommandKeys.some((key) => typeof definition[key] === 'string')
    if (definition.matcher === undefined && !hasDirectCommand) {
      const definitions = [...current]
      // Why: users can append groups or handlers after Orca's first install.
      // Reusing the exact slot preserves all later positional trust keys.
      const hooks = [...definition.hooks!]
      hooks[handlerIndex] = buildManagedCommandHook(command)
      definitions[groupIndex] = { ...definition, hooks }
      return { definitions, groupIndex, handlerIndex }
    }
  }

  const cleaned = removeManagedCommands(current, isManagedCommand)
  // Why: first install appends LAST so no existing user trust position shifts.
  return {
    definitions: [...cleaned, { hooks: [buildManagedCommandHook(command)] }],
    groupIndex: cleaned.length,
    handlerIndex: 0
  }
}
