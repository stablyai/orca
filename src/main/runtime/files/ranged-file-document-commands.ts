import type { RuntimeFileCommandHost } from './file-command-host'
import { requireLocalRuntimeFileRoute, resolveFileExplorerPath } from './file-target'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'
import { assertRuntimeReadWslDistroRunning } from '../runtime-wsl-background-read-gate'
import { RangedFileDocuments } from '../../ipc/filesystem/ranged-file-documents'

export class RuntimeRangedFileDocuments extends RangedFileDocuments {
  constructor(
    private readonly host: Pick<RuntimeFileCommandHost, 'requireStore' | 'resolveRuntimeFileTarget'>
  ) {
    super()
  }

  openTarget(
    owner: string,
    params: { worktree: string; relativePath: string },
    signal?: AbortSignal
  ) {
    return this.open(
      owner,
      async () => {
        const target = await resolveFileExplorerPath(
          this.host,
          params.worktree,
          params.relativePath
        )
        requireLocalRuntimeFileRoute(target)
        await assertRuntimeReadWslDistroRunning(target)
        return resolveRuntimeAuthorizedPath(target.path, this.host.requireStore())
      },
      signal
    )
  }
}
