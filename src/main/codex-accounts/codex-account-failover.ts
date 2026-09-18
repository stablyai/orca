import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import {
  getCodexSelectionTargetForAccount,
  getSelectedCodexAccountIdForTarget
} from './runtime-selection'

export type CodexAccountFailoverInput = {
  home: string
  signal: AbortSignal
  isSafe: () => boolean
  excludedHomes?: readonly string[]
  migrate: (account: CodexManagedAccount, isCurrent: () => boolean) => Promise<void>
}

export async function failoverCodexAccount(
  input: CodexAccountFailoverInput,
  deps: {
    settings: () => GlobalSettings
    generation: () => number
    findReplacement: () => Promise<CodexManagedAccount | null>
    serialize: (operation: () => Promise<boolean>) => Promise<boolean>
    select: (account: CodexManagedAccount) => Promise<unknown>
  }
): Promise<boolean> {
  const observedAt = Date.now()
  const generation = deps.generation()
  const candidate = await deps.findReplacement()
  if (!candidate) {
    return false
  }
  return deps.serialize(async () => {
    const settings = deps.settings()
    const outgoing = settings.codexManagedAccounts.find(
      (entry) => entry.managedHomePath === input.home
    )
    const isCurrent = (): boolean =>
      Date.now() - observedAt < 60_000 &&
      generation === deps.generation() &&
      deps.settings().codexAutomaticFailover === true &&
      !input.signal.aborted
    if (
      !isCurrent() ||
      !input.isSafe() ||
      !outgoing ||
      !settings.codexManagedAccounts.some(
        (entry) => entry.id === candidate.id && entry.managedHomePath === candidate.managedHomePath
      ) ||
      getSelectedCodexAccountIdForTarget(settings, getCodexSelectionTargetForAccount(outgoing)) !==
        outgoing.id
    ) {
      return false
    }
    await input.migrate(candidate, isCurrent)
    if (!isCurrent()) {
      throw new Error('Account switch superseded')
    }
    await deps.select(candidate)
    if (!isCurrent()) {
      throw new Error('Account switch superseded')
    }
    return true
  })
}
