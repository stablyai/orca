// The file reads a teammate may make in a shared bot's home folder. Admission already confined the
// call (bot-share-folder.ts); these check again once a read has run, and end a watch whose folder moved
// or was replaced, so nothing swapped in between admission and the read reaches the teammate.
import { SHARE_BY_BOT_FOLDER } from '../../../../../shared/bots/bot-share-rpc-methods'
import {
  confineBotShareFolderRead,
  folderIdentity
} from '../../../../bots/team-share/bot-share-folder'
import { folderConfinedTeammateOf } from '../../../../bots/team-share/teammate-workspace-view'
import type { RpcContext } from '../../core'

export const BOT_FOLDER_READ = { permission: 'workspace', share: SHARE_BY_BOT_FOLDER } as const

type FolderReadParams = { worktree: string; relativePath?: string }

/** A teammate's read answers only if its path still resolves to itself in the folder after the read. */
export function confinedFolderRead<P extends FolderReadParams, R>(
  read: (params: P, context: RpcContext) => Promise<R>
): (params: P, context: RpcContext) => Promise<R> {
  return async (params, context) => {
    const result = await read(params, context)
    const scope = folderConfinedTeammateOf(context)
    if (scope) {
      const again = await confineBotShareFolderRead(context.runtime, scope, params)
      if (again?.relativePath !== (params.relativePath ?? '')) {
        throw new Error('path_not_found')
      }
    }
    return result
  }
}

/** For a teammate's watch: each batch passes only while the folder is the one it started on (same
 *  path, device and inode); otherwise the watch ends, so a moved or swapped folder is never followed. */
export async function confinedFolderWatch(
  params: FolderReadParams,
  context: RpcContext,
  emit: (event: unknown) => void
): Promise<{ emit: (event: unknown) => void; signal: AbortSignal | undefined }> {
  const scope = folderConfinedTeammateOf(context)
  if (!scope) {
    return { emit, signal: context.signal }
  }
  const confined = await confineBotShareFolderRead(context.runtime, scope, params)
  const started = confined ? await folderIdentity(confined.realRoot) : null
  const ended = new AbortController()
  const end = (): void => ended.abort(new Error('path_not_found'))
  context.signal?.addEventListener('abort', () => ended.abort(context.signal?.reason), {
    once: true
  })
  if (!confined || !started) {
    end()
  }
  // In order: each batch waits for the check before it, and none passes once the folder changed.
  let checked = Promise.resolve()
  return {
    signal: ended.signal,
    emit: (event) => {
      checked = checked.then(async () => {
        if (ended.signal.aborted) {
          return
        }
        if (!confined || (await folderIdentity(confined.realRoot)) !== started) {
          end()
          return
        }
        emit(event)
      })
    }
  }
}
