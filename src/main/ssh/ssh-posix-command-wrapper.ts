import { gzipSync } from 'node:zlib'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

const REMOTE_COMMAND_CHUNK_MAX_BYTES = 1_024
const REMOTE_COMMAND_COMPRESSION_THRESHOLD_BYTES = 8_000
const REMOTE_COMMAND_PRINTF_ESCAPED_BYTES = new Set([0x21, 0x27, 0x5c])

function encodeRemoteCommandForPrintf(command: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  let chunkBytes = 0
  for (const character of command) {
    const codePoint = character.codePointAt(0)!
    const isSafePrintableAscii =
      codePoint >= 0x20 && codePoint <= 0x7e && !REMOTE_COMMAND_PRINTF_ESCAPED_BYTES.has(codePoint)
    const encodedCharacter =
      codePoint > 0x7f || isSafePrintableAscii
        ? character
        : `\\0${codePoint.toString(8).padStart(3, '0')}`
    const encodedBytes = codePoint > 0x7f ? Buffer.byteLength(character) : encodedCharacter.length
    if (chunkBytes + encodedBytes > REMOTE_COMMAND_CHUNK_MAX_BYTES) {
      chunks.push(chunk)
      chunk = ''
      chunkBytes = 0
    }
    chunk += encodedCharacter
    chunkBytes += encodedBytes
  }
  chunks.push(chunk)
  return chunks
}

/** The compressed wrapper's exit when the host has no base64 or gzip; nothing ran. */
export const REMOTE_COMMAND_DECODER_UNAVAILABLE_EXIT = 125
export const REMOTE_COMMAND_DECODER_UNAVAILABLE = 'ORCA_COMMAND_DECODER_UNAVAILABLE'

/** Wrap a POSIX snippet into one line that non-POSIX SSH login shells can forward. */
export function wrapRemoteCommandForPosixShell(
  command: string,
  options: { compress?: boolean } = {}
): string {
  // Why: csh/tcsh split multiline SSH exec strings before /bin/sh sees them.
  // POSIX printf rebuilds bounded argument chunks without consuming relay stdin.
  const encodedChunks = encodeRemoteCommandForPrintf(command)
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

  // Why: SSH gateways can truncate long exec requests, including activation's snapshot scripts.
  const compressed = gzipSync(Buffer.from(command), { level: 9 }).toString('base64')
  const compressedArguments = encodeRemoteCommandForPrintf(compressed)
    .map(quotePosixShell)
    .join(' ')
  // Keep stdin for relay/upload bytes, and only execute after gzip validates the whole script.
  // A host without the decoders exits before reading anything, so execCommand resends it plain.
  // `base64 -D` is macOS before 13, whose `base64` rejects `-d` before reading stdin.
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
