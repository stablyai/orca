// `files.watch`: a workspace's file changes as a stream; a teammate's watch of a shared bot's folder
// passes through confinedFolderWatch.
import { defineStreamingMethod } from '../../core'
import { FileWatch } from '../../../../../shared/rpc-contract/filesystem/files-target-params'
import { runFileWatchStream } from './file-watch-stream-lifecycle'
import { BOT_FOLDER_READ, confinedFolderWatch } from './files-bot-folder-read'

let filesWatchSubscriptionSeq = 0

export const FILE_WATCH_METHOD = defineStreamingMethod({
  name: 'files.watch',
  ...BOT_FOLDER_READ,
  params: FileWatch,
  handler: async (params, context, emit) => {
    const { runtime, connectionId } = context
    const seq = ++filesWatchSubscriptionSeq
    const subscriptionId = `files-watch-${connectionId ?? 'inproc'}-${seq}`
    const watch = await confinedFolderWatch(params, context, emit)
    await runFileWatchStream({
      runtime,
      worktree: params.worktree,
      batchCadence: params.batchCadence,
      connectionId,
      signal: watch.signal,
      subscriptionId,
      emit: watch.emit
    })
  }
})
