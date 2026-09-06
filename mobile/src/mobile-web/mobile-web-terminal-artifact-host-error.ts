export function terminalArtifactFailureCode(error: {
  code?: unknown
  message?: unknown
}): 'not_found' | 'too_large' | 'host_error' {
  const value = `${typeof error.code === 'string' ? error.code : ''} ${
    typeof error.message === 'string' ? error.message : ''
  }`.toLowerCase()
  if (value.includes('file_too_large')) {
    return 'too_large'
  }
  if (
    value.includes('terminal_file_grant') ||
    value.includes('not found') ||
    value.includes('no such file')
  ) {
    return 'not_found'
  }
  return 'host_error'
}
