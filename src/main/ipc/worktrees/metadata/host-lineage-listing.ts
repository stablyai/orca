import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence/loading-store/store'
import type {
  ListDesktopLineageForHostArgs,
  HostLineageSnapshot
} from '../../../../shared/host-lineage-contract'
import { parseExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getSshGitProvider } from '../../../providers/ssh-git-dispatch'
import type { SshGitProvider } from '../../../providers/ssh-git-provider'
import { isCurrentSshProviderAuthority } from '../../../ssh/ssh-provider-authority'
import { hasValidLineageSshAuthority } from '../listing/detected-provider-listing'
import { filterLineageForHost } from './workspace-lineage-filtering'

export const LINEAGE_HYDRATION_TIMEOUT_MS = 5_000

export async function hydrateLineageWithinDeadline(runtime: OrcaRuntimeService): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const hydration = Promise.resolve()
    .then(() => runtime.hydrateInferredWorktreeLineage())
    .then(
      () => true,
      () => false
    )
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), LINEAGE_HYDRATION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([hydration, deadline])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export async function listDesktopLineageForHost(
  store: Store,
  runtime: OrcaRuntimeService,
  args: ListDesktopLineageForHostArgs
): Promise<HostLineageSnapshot> {
  const parsedHost = parseExecutionHostId(args?.executionHostId)
  const rejected = (
    reason: Extract<HostLineageSnapshot, { authoritative: false }>['reason']
  ): HostLineageSnapshot => ({
    authoritative: false,
    executionHostId: args.executionHostId,
    reason
  })
  if (!parsedHost || parsedHost.kind === 'runtime') {
    return rejected('rejected')
  }
  let provider: SshGitProvider | undefined
  let authority:
    | Extract<ListDesktopLineageForHostArgs, { expectedAuthority: unknown }>['expectedAuthority']
    | null = null
  if (parsedHost.kind === 'local') {
    if ('expectedAuthority' in args) {
      return rejected('rejected')
    }
  } else {
    if (
      !hasValidLineageSshAuthority(args) ||
      args.expectedAuthority.targetId !== parsedHost.targetId
    ) {
      return rejected('rejected')
    }
    authority = { ...args.expectedAuthority }
    if (!isCurrentSshProviderAuthority(authority)) {
      return rejected('stale')
    }
    provider = getSshGitProvider(parsedHost.targetId)
    if (!provider) {
      return rejected('unavailable')
    }
  }
  if (!(await hydrateLineageWithinDeadline(runtime))) {
    return rejected('unavailable')
  }
  if (
    parsedHost.kind === 'ssh' &&
    (!authority ||
      getSshGitProvider(parsedHost.targetId) !== provider ||
      !isCurrentSshProviderAuthority(authority))
  ) {
    return rejected('stale')
  }
  const lineage = filterLineageForHost(store, parsedHost.id)
  if (!lineage) {
    return rejected('ambiguous-owner')
  }
  if (parsedHost.kind === 'local') {
    return {
      authoritative: true,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      ...lineage
    }
  }
  if (!authority) {
    return rejected('authority-unknown')
  }
  return {
    authoritative: true,
    authority: {
      kind: 'direct-ssh',
      executionHostId: parsedHost.id,
      ...authority
    },
    ...lineage
  }
}
