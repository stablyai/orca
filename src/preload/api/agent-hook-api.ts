import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../shared/setup-script-imports'

export type HooksApi = {
  /** `background`: a render-driven probe, refused (status 'error') rather than booting a stopped WSL distro. */
  check: (args: { repoId: string; hostId?: ExecutionHostId; background?: boolean }) => Promise<{
    status?: 'ok' | 'error'
    hasHooks: boolean
    hooks: OrcaHooks | null
    mayNeedUpdate: boolean
    /** A background check refused because the repo's WSL distro is stopped or didn't answer. */
    unavailable?: 'wsl-distro-stopped' | 'wsl-distro-unverifiable'
  }>
  inspectSetupScriptImports: (args: {
    repoId: string
    hostId?: ExecutionHostId
  }) => Promise<SetupScriptImportCandidate[]>
  /** `wakeWslDistro`: a launch, a user act that may start the repo's stopped WSL distro. */
  readIssueCommand: (args: {
    repoId: string
    hostId?: ExecutionHostId
    wakeWslDistro?: boolean
  }) => Promise<{
    status?: 'ok' | 'error'
    localContent: string | null
    sharedContent: string | null
    effectiveContent: string | null
    localFilePath: string
    source: 'local' | 'shared' | 'none'
    refusedWslDistro?: string
  }>
  writeIssueCommand: (args: {
    repoId: string
    content: string
    hostId?: ExecutionHostId
    wakeWslDistro?: boolean
  }) => Promise<void>
}
