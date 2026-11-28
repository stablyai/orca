import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../../shared/file-write/file-write-disk-precondition'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'
import type { RuntimeFileCommandHost } from './file-command-host'
import { assertRuntimeFileMutationExpectation } from './file-mutation-expectation'
import { requireLocalRuntimeFileRoute, resolveFileExplorerPath } from './file-target'
import { assertNotExists } from '../../filesystem/local-file-io/filesystem-create-path'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { StagedFileSaves, type StagedSaveKind } from './staged-file-saves'

// Private to this host's profile: a staged save never puts a file in the user's folders.
function profileStagingDir(): string | null {
  try {
    return join(getProfileUserDataPath(), 'staged-saves')
  } catch {
    return null
  }
}

// Early and best effort: the commit's exclusive create is what actually refuses a taken name.
async function assertUploadTargetFree(targetPath: string): Promise<void> {
  // Windows reads `a:b` as a stream of file `a`, so the upload would land inside another file.
  if (process.platform === 'win32' && basename(targetPath).includes(':')) {
    throw new Error(`'${basename(targetPath)}' is not a valid file name on this host`)
  }
  const fsPath = windowsFsPath(targetPath)
  await assertNotExists(fsPath)
  const folder = await stat(dirname(fsPath)).catch(() => null)
  if (!folder?.isDirectory()) {
    throw new Error('The folder to upload into no longer exists')
  }
}

type StagedSaveTarget = {
  worktree: string
  relativePath: string
  totalBytes: number
  expectedExecutionHostId?: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

/** The runtime's staged saves: the target is resolved and authorized once, at begin. */
export class RuntimeStagedFileSaves {
  constructor(
    private readonly host: Pick<
      RuntimeFileCommandHost,
      'requireStore' | 'resolveRuntimeFileTarget'
    >,
    private readonly saves = new StagedFileSaves({ stagingDir: profileStagingDir })
  ) {}

  /** 'upload' creates a new file, so it is refused up front if the name is taken or its folder is gone. */
  async begin(
    owner: string,
    params: StagedSaveTarget,
    kind: StagedSaveKind = 'save'
  ): Promise<{ saveId: string }> {
    const target = await resolveFileExplorerPath(this.host, params.worktree, params.relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      params.expectedExecutionHostId,
      params.expectedSshTargetId,
      params.expectedSshConnectionGeneration
    )
    requireLocalRuntimeFileRoute(target)
    const realPath = await this.authorize(target.path, kind)
    if (kind === 'upload') {
      await assertUploadTargetFree(realPath)
    }
    return this.saves.begin(
      owner,
      { requestedPath: target.path, realPath },
      params.totalBytes,
      kind
    )
  }

  append(owner: string, saveId: string, offset: number, bytes: Buffer): Promise<void> {
    return this.saves.append(owner, saveId, offset, bytes)
  }

  commit(
    owner: string,
    saveId: string,
    precondition: FileWriteDiskPrecondition | undefined
  ): Promise<FileWriteResult> {
    return this.saves.commit(owner, saveId, precondition, (path) => this.authorize(path, 'save'))
  }

  commitUpload(owner: string, saveId: string): Promise<void> {
    return this.saves.commitUpload(owner, saveId, (path) => this.authorize(path, 'upload'))
  }

  abort(owner: string, saveId: string): Promise<void> {
    return this.saves.abort(owner, saveId)
  }

  abortConnection(owner: string): Promise<void> {
    return this.saves.abortConnection(owner)
  }

  /** Host start, in the background: a hung mount must not hold the host up. */
  sweepOrphans(): void {
    void this.saves.sweepOrphans()
  }

  // An upload keeps the leaf: a link already at that name makes the name taken, not a way through.
  private authorize(path: string, kind: StagedSaveKind): Promise<string> {
    return resolveRuntimeAuthorizedPath(path, this.host.requireStore(), {
      preserveSymlink: kind === 'upload'
    })
  }
}
