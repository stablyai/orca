import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

/**
 * An older host answers an unknown method with `method_not_found`. Surface the
 * upgrade path instead, and never let the raw code reach human or --json output.
 */
export function rewriteUnsupportedLinearProjectHost(error: unknown, command: string): unknown {
  const code =
    error instanceof RuntimeRpcFailureError
      ? error.response.error.code
      : error instanceof RuntimeClientError
        ? error.code
        : undefined
  if (code !== 'method_not_found') {
    return error
  }
  return new RuntimeClientError(
    'unsupported_host',
    [
      `This Orca host does not support \`orca ${command}\`.`,
      'Update the remote Orca host and retry.',
      '`orca linear project list --json` remains available only as a read-only fallback; its success does not imply project-write support.'
    ].join(' ')
  )
}
