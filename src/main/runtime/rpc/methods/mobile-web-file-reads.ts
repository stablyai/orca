import { boundMobileWebFileContent } from './mobile-web-file-content'
import { MOBILE_WEB_FILE_DIRECTORY_READ_METHOD } from './mobile-web-file-directory-read'
import { defineMethod, isStreamingMethod } from '../core'
import { FILE_METHODS } from './files'

// Desktop owns identity redaction; installed shells need no file-result vocabulary.
export const MOBILE_WEB_FILE_READ_METHODS = ['searchPaths', 'read'].map((operation) => {
  const source = FILE_METHODS.find((method) => method.name === `files.${operation}`)
  if (!source || isStreamingMethod(source)) {
    throw new Error(`Missing unary file method: ${operation}`)
  }
  return defineMethod({
    name: `mobileWeb.files.${operation}`,
    params: source.params,
    handler: async (params, context) => {
      const result = await source.handler(params, context)
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new Error('Invalid file read result')
      }
      const pageResult: Record<string, unknown> = { ...result }
      delete pageResult.worktree
      delete pageResult.rootPath
      return operation === 'read' ? boundMobileWebFileContent(pageResult) : pageResult
    }
  })
})

MOBILE_WEB_FILE_READ_METHODS.push(MOBILE_WEB_FILE_DIRECTORY_READ_METHOD)
