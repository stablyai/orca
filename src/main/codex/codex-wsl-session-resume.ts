import { posix } from 'node:path'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  assertWslAccountExecutionTarget,
  type WslAccountExecutionContext
} from '../wsl/wsl-account-execution-context'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import {
  claimsCodexRolloutLayout,
  type CodexSessionResumePreparation
} from './codex-session-resume-home'
import { prepareCodexSessionResume } from './codex-session-resume-preparation'
import { probeCodexWslResumeFiles } from './codex-wsl-resume-file-probe'

function guestPath(path: string, execution: WslAccountExecutionContext): string | null {
  const unc = parseWslUncPath(path)
  if (unc && unc.distro.toLowerCase() !== execution.distro.toLowerCase()) {
    return null
  }
  const candidate = unc?.linuxPath ?? path
  return candidate.startsWith(`${execution.home}/`) &&
    posix.normalize(candidate) === candidate &&
    !/[\\\0\r\n]/.test(candidate)
    ? candidate
    : null
}

/** Reuse provenance and legacy ranking, but never inspect guest files through Windows filesystem APIs. */
export async function prepareCapturedWslCodexSessionResume(args: {
  execution: WslAccountExecutionContext
  target: CodexAccountSelectionTarget
  providerSession: AgentProviderSessionMetadata
  accounts: readonly CodexManagedAccount[]
  selectedAccountId: string | null
}): Promise<CodexSessionResumePreparation> {
  const execution = Object.freeze({ ...args.execution })
  const providerSession = Object.freeze({ ...args.providerSession })
  assertWslAccountExecutionTarget(execution, args.target)
  const systemHome = posix.join(execution.home, '.codex')
  const homes = new Map<string, string>()
  for (const account of args.accounts) {
    const unc = parseWslUncPath(account.managedHomePath)
    const distro = account.managedHomeRuntime === 'wsl' ? account.wslDistro : unc?.distro
    const path = account.managedHomeRuntime === 'wsl' ? account.wslLinuxHomePath : unc?.linuxPath
    if (distro?.toLowerCase() === execution.distro.toLowerCase() && path) {
      const home = guestPath(path, execution)
      if (home) {
        homes.set(account.id, home)
      }
    }
  }
  const selectedHome = args.selectedAccountId ? homes.get(args.selectedAccountId) : null
  if (args.selectedAccountId && !selectedHome) {
    throw new Error('Selected Codex account does not belong to the captured WSL owner')
  }
  const claimed = providerSession.transcriptPath?.trim()
  const transcriptPath = claimed ? guestPath(claimed, execution) : null
  const fresh: CodexSessionResumePreparation = {
    outcome: 'fresh',
    claimedCodexProvenance: claimsCodexRolloutLayout(claimed)
  }
  if (
    (claimed && !transcriptPath) ||
    (!claimed && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(providerSession.id))
  ) {
    return fresh
  }
  const trustedHomes = [...new Set([systemHome, ...homes.values()])]
  // Linux permits distinct NFC/NFD homes; shared comparison must never merge their accounts.
  if (new Set(trustedHomes.map(normalizeRuntimePathForComparison)).size !== trustedHomes.length) {
    throw new Error('Codex account homes have ambiguous WSL path identities')
  }
  const files = await probeCodexWslResumeFiles({
    execution,
    homes: trustedHomes,
    sessionId: providerSession.id,
    transcriptPath: transcriptPath ?? ''
  })
  const asUnc = (path: string) => toWindowsWslUncPath(path, execution.distro)
  const checkedFiles = new Map(
    [...files].map((path) => [normalizeRuntimePathForComparison(asUnc(path)), path])
  )
  return prepareCodexSessionResume({
    sessionId: providerSession.id,
    transcriptPath: transcriptPath ? asUnc(transcriptPath) : undefined,
    trustedCodexHomes: trustedHomes.map(asUnc),
    getSelectedAccountCodexHome: () => (selectedHome ? asUnc(selectedHome) : null),
    systemCodexHomePath: asUnc(systemHome),
    sharedRuntimeCodexHomePath: null,
    fileIsRegular: (path) => checkedFiles.has(normalizeRuntimePathForComparison(path)),
    async *listSessionFiles(sessionsRoot) {
      const prefix = `${normalizeRuntimePathForComparison(sessionsRoot)}/`
      for (const [key, path] of checkedFiles) {
        if (key.startsWith(prefix)) {
          yield asUnc(path)
        }
      }
    },
    resolveVerifiedResumeHome: async ({ homePath }) => {
      const home = guestPath(homePath, execution)
      if (!home) {
        throw new Error('Verified Codex session escaped its captured WSL owner')
      }
      return home
    }
  })
}
