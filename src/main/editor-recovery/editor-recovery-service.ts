import { join } from 'node:path'
import type { Store } from '../persistence'
import {
  editorRecoverySessionResources,
  applyEditorRecoverySessionDrafts,
  editorRecoverySessionCheckpointIds,
  editorRecoverySessionFileMetadata
} from '../../shared/editor-recovery-session'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { EditorRecoveryMetadata } from '../../shared/editor-recovery'
import { EditorRecoveryWorker } from './editor-recovery-worker'

export class EditorRecoveryService {
  private initialization: Promise<EditorRecoveryWorker> | null = null

  constructor(
    private readonly store: Pick<
      Store,
      'getWorkspaceSessionHostIds' | 'getWorkspaceSession' | 'getProfileStorageDirectory'
    >,
    private readonly createWorker = (path: string): EditorRecoveryWorker =>
      new EditorRecoveryWorker(path)
  ) {}

  ready(): Promise<EditorRecoveryWorker> {
    return (this.initialization ??= this.initialize()).then((worker) => {
      if (worker.isRunning) {
        return worker
      }
      this.initialization = null
      return this.ready()
    })
  }
  async close(): Promise<void> {
    const initialization = this.initialization
    this.initialization = null
    if (initialization) {
      await (await initialization).close()
    }
  }

  async restoreSession(
    session: WorkspaceSessionState,
    host?: string | null
  ): Promise<WorkspaceSessionState> {
    const resources = editorRecoverySessionResources(session, host)
    if (resources.length === 0) {
      return session
    }
    const worker = await this.ready()
    const recovered = await worker.restore(resources, editorRecoverySessionCheckpointIds(session))
    return applyEditorRecoverySessionDrafts(
      session,
      recovered.drafts,
      new Set(recovered.resolvedIds)
    )
  }

  private async initialize(): Promise<EditorRecoveryWorker> {
    const worker = this.createWorker(
      join(this.store.getProfileStorageDirectory(), 'editor-recovery.sqlite')
    )
    try {
      const drafts: { metadata: EditorRecoveryMetadata; content: string }[] = []
      const sessions = this.store
        .getWorkspaceSessionHostIds()
        .map((hostId) => ({ hostId, session: this.store.getWorkspaceSession(hostId) }))
      const knownIds = new Set(
        (
          await worker.status(
            sessions.flatMap(({ session }) => editorRecoverySessionCheckpointIds(session))
          )
        ).map((entry) => entry.id)
      )
      for (const { hostId, session } of sessions) {
        for (const [worktreeId, files] of Object.entries(session.openFilesByWorktree ?? {})) {
          for (const file of files) {
            if (file.readOnly || file.dirtyDraftContent === undefined) {
              continue
            }
            if (file.recoveryId && knownIds.has(file.recoveryId)) {
              continue
            }
            drafts.push({
              metadata: editorRecoverySessionFileMetadata(file, worktreeId, hostId),
              content: file.dirtyDraftContent
            })
          }
        }
      }
      await worker.importLegacy(drafts)
      return worker
    } catch (error) {
      void worker.close().catch(() => {})
      // Leave the journal and legacy session intact; a later request may retry after a disk failure.
      this.initialization = null
      throw error
    }
  }
}
