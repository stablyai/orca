import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { app } from 'electron'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'

export type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  fileName?: string | null
}

const REMOTE_CLIPBOARD_IMAGE_TEMP_DIR = '/tmp'
// Bytes, not code units: the name is appended to a temp path and must stay under
// the 255-byte NAME_MAX on ext4/APFS (local temp and SSH-remote /tmp alike),
// leaving headroom for the `orca-file-<ts>-<uuid>-` prefix.
const ATTACHMENT_FILE_NAME_MAX_BYTES = 80
// Safe = Unicode letters/numbers/marks plus ASCII dot, dash, underscore.
// Everything else — whitespace, shell metacharacters, path separators, control
// and Unicode format/separator characters — is dropped, because the sanitized
// name lands in a path pasted verbatim into the user's live terminal, where a
// space breaks path tokenization and `;`/`$()`/backticks would execute on Enter.
const SAFE_ATTACHMENT_FILE_NAME_CHAR = /[\p{L}\p{N}\p{M}._-]/u
// Cap the raw input before any per-code-point work: the RPC layer also bounds
// fileName, but sanitization cost must never scale with attacker-sized input.
const ATTACHMENT_FILE_NAME_MAX_INPUT_CHARS = 1024

export function sanitizeAttachmentFileName(fileName: string): string | null {
  // NFC first so accented letters are single code points the allowlist keeps.
  // (A surrogate pair split by the slice fails the allowlist and is dropped.)
  const filtered = Array.from(
    fileName.slice(0, ATTACHMENT_FILE_NAME_MAX_INPUT_CHARS).normalize('NFC')
  )
    .filter((char) => SAFE_ATTACHMENT_FILE_NAME_CHAR.test(char))
    .join('')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  if (!filtered) {
    return null
  }
  return truncateFileNameToBytes(filtered, ATTACHMENT_FILE_NAME_MAX_BYTES)
}

function truncateFileNameToBytes(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) {
    return name
  }
  const extension = path.posix.extname(name)
  const keepExtension = extension.length > 0 && Buffer.byteLength(extension) < maxBytes
  const budget = keepExtension ? maxBytes - Buffer.byteLength(extension) : maxBytes
  const body = keepExtension ? name.slice(0, name.length - extension.length) : name
  let truncated = ''
  let usedBytes = 0
  // Iterate by code point so a multibyte character is never split at the cut.
  for (const char of body) {
    const charBytes = Buffer.byteLength(char)
    if (usedBytes + charBytes > budget) {
      break
    }
    truncated += char
    usedBytes += charBytes
  }
  // Re-strip a trailing dot the cut may have exposed (Windows drops it silently).
  const result = (truncated + (keepExtension ? extension : '')).replace(/\.+$/, '')
  return result || truncated
}

function buildAttachmentTempFileName(originalFileName: string | null | undefined): string {
  if (originalFileName == null) {
    // Byte-identical to the historical clipboard-paste name for existing callers.
    return `orca-paste-${Date.now()}-${randomUUID()}.png`
  }
  const sanitized = sanitizeAttachmentFileName(originalFileName)
  const generated = `orca-file-${Date.now()}-${randomUUID()}`
  return sanitized ? `${generated}-${sanitized}` : generated
}

function joinRemotePath(basePath: string, fileName: string): string {
  if (isWindowsAbsolutePathLike(basePath)) {
    return path.win32.join(basePath, fileName)
  }
  return path.posix.join(basePath, fileName)
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  const fileName = buildAttachmentTempFileName(args?.fileName)

  if (args?.connectionId) {
    const provider = requireSshFilesystemProvider(args.connectionId)
    const remoteTempDir = (await provider.getTempDir?.()) ?? REMOTE_CLIPBOARD_IMAGE_TEMP_DIR
    const remotePath = joinRemotePath(remoteTempDir, fileName)
    // Why: SSH terminal agents run on the remote host, so the pasted path must
    // name a remote file. The provider's base64 path writes binary bytes via SFTP.
    await provider.writeFileBase64(remotePath, buffer.toString('base64'))
    return remotePath
  }

  const tempPath = path.join(app.getPath('temp'), fileName)
  await fs.writeFile(tempPath, buffer)
  return tempPath
}
