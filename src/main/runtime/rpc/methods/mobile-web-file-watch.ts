import { defineStreamingMethod, isStreamingMethod } from '../core'
import { FILE_METHODS } from './files'

const source = FILE_METHODS.find((method) => method.name === 'files.watch')
if (!source || !isStreamingMethod(source)) {
  throw new Error('Missing file watch stream')
}
const fileWatch = source

export const MOBILE_WEB_FILE_WATCH_METHOD = defineStreamingMethod({
  name: 'mobileWeb.files.watch',
  params: fileWatch.params,
  handler: (params, context, emit) =>
    fileWatch.handler(params, context, (event) => {
      if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        throw new Error('Invalid file watch event')
      }
      const pageEvent: Record<string, unknown> = { ...event }
      delete pageEvent.worktree
      emit(pageEvent)
    })
})
