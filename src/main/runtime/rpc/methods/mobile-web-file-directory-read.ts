import { MobileWebFileDirectoryPayloadSchema } from '../../../../shared/mobile-web/file-operation-contract'
import { sanitizeDirectoryResult } from '../../../../shared/mobile-web/file-host-presentation'
import { defineMethod, isStreamingMethod } from '../core'
import { FILE_METHODS } from './files'
import { WorktreeSelector } from './files-target-schemas'

const source = FILE_METHODS.find((method) => method.name === 'files.readDir')
if (!source || isStreamingMethod(source)) {
  throw new Error('Missing unary directory method')
}
const readDirectory = source

export const MOBILE_WEB_FILE_DIRECTORY_READ_METHOD = defineMethod({
  name: 'mobileWeb.files.readDir',
  params: WorktreeSelector.extend(
    MobileWebFileDirectoryPayloadSchema.omit({ workspaceId: true }).shape
  ),
  handler: async ({ worktree, relativePath, limit }, context) => {
    const result = await readDirectory.handler({ worktree, relativePath }, context)
    // Trim before crossing the bridge; a large directory must still open within its ceiling.
    return sanitizeDirectoryResult(result, relativePath, limit)
  }
})
