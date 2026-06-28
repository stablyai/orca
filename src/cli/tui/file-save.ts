import type { TuiRpcClient } from './tui-rpc-client'
import type { FileEditor } from './file-editor'

export type SaveResult = 'saved' | 'conflict' | 'failed'

/** Write the editor buffer, guarding against clobbering an external change.
 *  Prefers the runtime compare-and-swap (files.writeIfUnchanged); falls back to
 *  a client-side read-then-write on older runtimes that lack it. */
export async function saveFileTab(
  client: TuiRpcClient,
  worktree: string,
  relativePath: string,
  editor: FileEditor,
  allowOverwrite: boolean
): Promise<SaveResult> {
  try {
    if (allowOverwrite) {
      await client.call('files.write', { worktree, relativePath, content: editor.content })
      editor.markSaved()
      return 'saved'
    }
    return await casSave(client, worktree, relativePath, editor)
  } catch {
    return 'failed'
  }
}

/** Atomic compare-and-swap at the runtime: writes only if the file still matches
 *  what we loaded. Older runtimes without the RPC fall back to read-then-write. */
async function casSave(
  client: TuiRpcClient,
  worktree: string,
  relativePath: string,
  editor: FileEditor
): Promise<SaveResult> {
  try {
    const { result } = await client.call<{ status: 'saved' | 'conflict' }>(
      'files.writeIfUnchanged',
      { worktree, relativePath, content: editor.content, expectedContent: editor.savedContent }
    )
    if (result.status === 'conflict') {
      return 'conflict'
    }
    if (result.status !== 'saved') {
      // An unexpected verdict is a real failure, not a save — don't mark clean.
      throw new Error('invalid_cas_status')
    }
    editor.markSaved()
    return 'saved'
  } catch (error) {
    // Only fall back when the runtime lacks the CAS RPC; surface real failures.
    if (!isUnknownMethodError(error)) {
      throw error
    }
    const { result } = await client.call<{ content?: string }>('files.read', {
      worktree,
      relativePath
    })
    if ((result.content ?? '') !== editor.savedContent) {
      return 'conflict'
    }
    await client.call('files.write', { worktree, relativePath, content: editor.content })
    editor.markSaved()
    return 'saved'
  }
}

function isUnknownMethodError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unknown method|method not found/i.test(message)
}
