import {
  NodeFileReadTooLargeError,
  readNodeFileSyncWithinLimit
} from '../../shared/node-bounded-file-reader'

export function readAgentHookFileForComparison(path: string, maxBytes: number): string | null {
  try {
    return readNodeFileSyncWithinLimit(path, maxBytes).buffer.toString('utf8')
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      throw error
    }
    return null
  }
}
