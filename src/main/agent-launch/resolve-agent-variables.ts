// Launch variable resolution: the {repoPath}/{worktreePath} scan, target-native
// (WSL) value translation, and per-string interpolation. Values are resolved to
// target-native form BEFORE substitution and a missing/empty referenced value
// fails the whole launch with no partial output.

import { parseWslUncPath } from '../../shared/wsl-paths'
import { toLinuxPath } from '../wsl'

export type LaunchVariableName = 'repoPath' | 'worktreePath'

/** Ordered so the first-missing report is deterministic. */
export const LAUNCH_VARIABLE_ORDER: readonly LaunchVariableName[] = ['repoPath', 'worktreePath']

export type LaunchVariableValues = {
  repoPath: string | null
  worktreePath: string | null
}

const VARIABLE_TOKENS: Record<LaunchVariableName, string> = {
  repoPath: '{repoPath}',
  worktreePath: '{worktreePath}'
}

function toTargetNative(
  value: string | null | undefined,
  execution: 'native' | 'wsl'
): string | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  if (execution !== 'wsl') {
    return value
  }
  // A Windows-form (drive or UNC) path must never enter a WSL argv.
  const unc = parseWslUncPath(value)
  if (unc) {
    return unc.linuxPath
  }
  return toLinuxPath(value)
}

/** Resolve the two supported variables to target-native values. Empty strings
 *  collapse to null so an empty-string substitution is treated as missing. */
export function prepareVariableValues(
  variables: { repoPath?: string | null; worktreePath?: string | null },
  execution: 'native' | 'wsl'
): LaunchVariableValues {
  return {
    repoPath: toTargetNative(variables.repoPath, execution),
    worktreePath: toTargetNative(variables.worktreePath, execution)
  }
}

/** Whether `text` references the given variable token. */
export function referencesVariable(text: string, name: LaunchVariableName): boolean {
  return text.includes(VARIABLE_TOKENS[name])
}

/** Collect every variable referenced across the provided strings. */
export function collectReferencedVariables(texts: readonly string[]): Set<LaunchVariableName> {
  const referenced = new Set<LaunchVariableName>()
  for (const text of texts) {
    for (const name of LAUNCH_VARIABLE_ORDER) {
      if (referencesVariable(text, name)) {
        referenced.add(name)
      }
    }
  }
  return referenced
}

/** The first referenced variable (in canonical order) whose value is missing,
 *  or null when every referenced variable has a value. */
export function firstMissingVariable(
  referenced: ReadonlySet<LaunchVariableName>,
  values: LaunchVariableValues
): LaunchVariableName | null {
  for (const name of LAUNCH_VARIABLE_ORDER) {
    if (referenced.has(name) && values[name] === null) {
      return name
    }
  }
  return null
}

/** Replace both supported tokens with their resolved values. Callers must have
 *  already verified referenced values are present; unknown brace text stays
 *  literal because only the two documented tokens are special. */
export function interpolateVariables(text: string, values: LaunchVariableValues): string {
  return text
    .split(VARIABLE_TOKENS.repoPath)
    .join(values.repoPath ?? '')
    .split(VARIABLE_TOKENS.worktreePath)
    .join(values.worktreePath ?? '')
}
