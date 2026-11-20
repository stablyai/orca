import * as path from 'node:path'
import { isWindowsAbsolutePathLike } from '../../../shared/file-access/cross-platform-path'
import { observeLocalWatcherEvents } from '../../ipc/filesystem/watchers/local-watcher-event-observers'
import { clearPipelineConfigCache, invalidatePipelineConfig } from './pipeline-config-loader'

export function pipelineConfigRootForPath(eventPath: string): string | null {
  const pathApi = isWindowsAbsolutePathLike(eventPath) ? path.win32 : path.posix
  const normalized = pathApi.normalize(eventPath)
  if (pathApi.basename(normalized) !== 'pipeline.json') {
    return null
  }
  const orcaDir = pathApi.dirname(normalized)
  if (pathApi.basename(orcaDir) !== '.orca') {
    return null
  }
  return pathApi.dirname(orcaDir)
}

let watching = false

export function ensurePipelineConfigWatch(): void {
  if (watching) {
    return
  }
  watching = true
  observeLocalWatcherEvents({
    onEvents: (_root, events) => {
      for (const event of events) {
        const workspaceRoot = pipelineConfigRootForPath(event.path)
        if (workspaceRoot) {
          invalidatePipelineConfig(workspaceRoot)
        }
      }
    },
    onInterrupted: () => {
      clearPipelineConfigCache()
    }
  })
}
