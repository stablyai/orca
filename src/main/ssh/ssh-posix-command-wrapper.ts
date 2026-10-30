import { encodePosixPrintfRecords } from '../../shared/posix-printf-encoding'
import { gzipSync } from 'node:zlib'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

const REMOTE_COMMAND_COMPRESSION_THRESHOLD_BYTES = 8_000

/** The compressed wrapper's exit when the host has no base64 or gzip; nothing ran. */
export const REMOTE_COMMAND_DECODER_UNAVAILABLE_EXIT = 125
export const REMOTE_COMMAND_DECODER_UNAVAILABLE = 'ORCA_COMMAND_DECODER_UNAVAILABLE'

export function wrapRemoteCommandForPosixShell(
  command: string,
  options: { compress?: boolean } = {}
): string {
  // csh/tcsh split multiline exec strings; rebuild bounded printf chunks without consuming relay stdin.
  const encodedChunks = [...encodePosixPrintfRecords(command)]
  const runDecoded = 'decoded=${decoded%_}; exec /bin/sh -c "$decoded"'
  const decodeAndRun = `decoded=$(printf %b "$@" && printf _) || exit $?; ${runDecoded}`
  const chunkArguments = encodedChunks.map(quotePosixShell).join(' ')
  const wrapped = `exec /bin/sh -c ${quotePosixShell(decodeAndRun)} orca-command ${chunkArguments}`
  if (
    options.compress === false ||
    Buffer.byteLength(wrapped) <= REMOTE_COMMAND_COMPRESSION_THRESHOLD_BYTES
  ) {
    return wrapped
  }

  // Compress long scripts before gateways can truncate the exec request.
  const compressed = gzipSync(Buffer.from(command), { level: 9 }).toString('base64')
  const compressedArguments = [...encodePosixPrintfRecords(compressed)]
    .map(quotePosixShell)
    .join(' ')
  // Preserve payload stdin and execute only after gzip validation. Missing decoders consume nothing, permitting plain retry; macOS before 13 needs base64 -D.
  const decompressAndRun =
    'command -v base64 >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1 || ' +
    `{ echo ${REMOTE_COMMAND_DECODER_UNAVAILABLE} >&2; exit ${REMOTE_COMMAND_DECODER_UNAVAILABLE_EXIT}; }; ` +
    'decoded=$(printf %s "$@" | { base64 -d 2>/dev/null || base64 -D; } | gzip -dc && printf _) || ' +
    `exit $?; ${runDecoded}`
  const compressedWrapped = `exec /bin/sh -c ${quotePosixShell(decompressAndRun)} orca-command ${compressedArguments}`
  return Buffer.byteLength(compressedWrapped) < Buffer.byteLength(wrapped)
    ? compressedWrapped
    : wrapped
}
