import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { mapDirectSshScans } from '../ai-vault/remote-session-scan-concurrency'
import { mergeAiVaultListResults } from '../ai-vault/session-list-results'

const activeAbortControllers = new Set<AbortController>()

export async function scanAllAiVaultHosts<SshHost, RuntimeHost>(args: {
  sshHosts: readonly SshHost[]
  runtimeHosts: readonly RuntimeHost[]
  runtimeIssues: readonly AiVaultListResult[]
  limit?: number
  scanLocal: () => Promise<AiVaultListResult>
  scanSsh: (host: SshHost, signal: AbortSignal) => Promise<AiVaultListResult>
  scanRuntime: (host: RuntimeHost) => Promise<AiVaultListResult>
}): Promise<AiVaultListResult> {
  const controller = new AbortController()
  activeAbortControllers.add(controller)
  try {
    const [localResult, sshResults, runtimeResults] = await Promise.all([
      args.scanLocal(),
      mapDirectSshScans(args.sshHosts, args.scanSsh, controller.signal),
      Promise.all(args.runtimeHosts.map(args.scanRuntime))
    ])
    return mergeAiVaultListResults(
      [localResult, ...sshResults, ...runtimeResults, ...args.runtimeIssues],
      args.limit
    )
  } finally {
    activeAbortControllers.delete(controller)
  }
}

export function resetAllAiVaultHostScansForTests(): void {
  for (const controller of activeAbortControllers) {
    controller.abort()
  }
  activeAbortControllers.clear()
}
