import type { ResolvedCommand } from './wsl-command-resolution'

/**
 * Slice a fenced payload out of raw bytes.
 *
 * Why bytes: blob content may be binary, so decoding to a string to find the
 * fence would corrupt it. Returns the buffer untouched when the command was not
 * fenced or the fence is absent.
 */
export function readCapturedGitBuffer(stdout: Buffer, resolved: ResolvedCommand): Buffer {
  const captured = resolved.captured
  if (!captured) {
    return stdout
  }
  const beginIndex = stdout.lastIndexOf(captured.beginMarker, undefined, 'utf8')
  if (beginIndex === -1) {
    return stdout
  }
  const payloadStart = beginIndex + Buffer.byteLength(captured.beginMarker, 'utf8')
  const endIndex = stdout.indexOf(captured.endMarker, payloadStart, 'utf8')
  return endIndex === -1 ? stdout.subarray(payloadStart) : stdout.subarray(payloadStart, endIndex)
}

export function readCapturedGitString(stdout: string, resolved: ResolvedCommand): string {
  const captured = resolved.captured
  if (!captured) {
    return stdout
  }
  const beginIndex = stdout.lastIndexOf(captured.beginMarker)
  if (beginIndex === -1) {
    return stdout
  }
  const payloadStart = beginIndex + captured.beginMarker.length
  const endIndex = stdout.indexOf(captured.endMarker, payloadStart)
  return endIndex === -1 ? stdout.slice(payloadStart) : stdout.slice(payloadStart, endIndex)
}
