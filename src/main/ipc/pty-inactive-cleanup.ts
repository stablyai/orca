import type { IPtyProvider } from '../providers/types'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { PtyCleanupInspection, PtyCleanupSafety } from '../../shared/pty-inactive-cleanup'

export type PtyInactiveCleanupProvider = Pick<
  IPtyProvider,
  | 'listProcesses'
  | 'hasChildProcesses'
  | 'confirmForegroundProcess'
  | 'providesAgentSessionOwnerListings'
>

export type PtyInactiveCleanupTarget = {
  id: string
  provider: PtyInactiveCleanupProvider | null
}

function classifyInspection(
  children: PromiseSettledResult<boolean>,
  foreground: PromiseSettledResult<string | null>
): PtyCleanupSafety {
  if (children.status === 'fulfilled' && children.value) {
    return 'active'
  }
  if (
    foreground.status === 'fulfilled' &&
    foreground.value !== null &&
    !isShellProcess(foreground.value)
  ) {
    return 'active'
  }
  if (
    children.status === 'fulfilled' &&
    !children.value &&
    foreground.status === 'fulfilled' &&
    foreground.value !== null &&
    isShellProcess(foreground.value)
  ) {
    return 'inactive'
  }
  return 'unknown'
}

async function inspectProviderTargets(
  provider: PtyInactiveCleanupProvider,
  ids: string[]
): Promise<Map<string, PtyCleanupSafety>> {
  const safetyById = new Map<string, PtyCleanupSafety>(ids.map((id) => [id, 'unknown']))
  let liveProcesses: Map<string, Awaited<ReturnType<typeof provider.listProcesses>>[number]>
  try {
    liveProcesses = new Map(
      (await provider.listProcesses()).map((process) => [process.id, process])
    )
  } catch {
    return safetyById
  }

  await Promise.all(
    ids.map(async (id) => {
      const process = liveProcesses.get(id)
      if (!process) {
        safetyById.set(id, 'gone')
        return
      }
      if (process.agentSessionOwners?.length) {
        safetyById.set(id, 'active')
        return
      }
      if (provider.providesAgentSessionOwnerListings?.(id) !== true) {
        // Why: silence from a legacy provider is not proof that no agent owns the shell.
        return
      }

      const confirmedForeground = provider.confirmForegroundProcess
        ? provider.confirmForegroundProcess(id)
        : Promise.resolve(null)
      const [children, foreground] = await Promise.allSettled([
        provider.hasChildProcesses(id),
        confirmedForeground
      ])
      safetyById.set(id, classifyInspection(children, foreground))
    })
  )
  return safetyById
}

export async function inspectPtyInactiveCleanupTargets(
  targets: PtyInactiveCleanupTarget[]
): Promise<PtyCleanupInspection[]> {
  const providerIds = new Map<PtyInactiveCleanupProvider, string[]>()
  for (const { id, provider } of targets) {
    if (!provider) {
      continue
    }
    const ids = providerIds.get(provider)
    if (ids) {
      ids.push(id)
    } else {
      providerIds.set(provider, [id])
    }
  }

  const safetyByProvider = new Map<PtyInactiveCleanupProvider, Map<string, PtyCleanupSafety>>()
  await Promise.all(
    [...providerIds].map(async ([provider, ids]) => {
      safetyByProvider.set(provider, await inspectProviderTargets(provider, ids))
    })
  )

  return targets.map(({ id, provider }) => ({
    id,
    safety: provider ? (safetyByProvider.get(provider)?.get(id) ?? 'unknown') : 'unknown'
  }))
}
