// Why: jcode's headless `run` has no --file/--attach flag — it only reads files
// it is TOLD about by path (via its own READ/BASH tools) and consumes inline
// content from the prompt text. So composer attachments are delivered by WEAVING
// them into the prompt string: file paths as a clearly-labelled list jcode can
// read, and text blobs fenced inline so they don't bloat the input box.
//
// For remote-exec (brain-local) sessions the agent runs locally but its bash/read
// tools execute on the REMOTE host, so a local path is meaningless there. The
// caller copies each local file to a remote temp dir first and passes the rewritten
// REMOTE path here; this module stays transport-agnostic and only formats text.
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, posix as pathPosix } from 'node:path'
import type { JcodeChatAttachment, JcodeChatSendPayload } from '../../shared/jcode-chat-types'
import { getLiveSshConnection, runRemoteCommand, shellQuote } from './jcode-ssh-command'

/** A file attachment after any path rewriting (e.g. local -> remote temp). */
export type ResolvedFileAttachment = {
  /** The path jcode should read (local for local sessions; remote for remote-exec). */
  path: string
  /** Display name for the prompt list. */
  name: string
}

/** Weave resolved file paths + inline text blobs into the final prompt jcode
 *  receives. The user's typed text stays the lead; attachments are appended in
 *  clearly-delimited blocks so the model treats them as context. Returns the
 *  original prompt unchanged when there is nothing to attach. */
export function weaveAttachmentsIntoPrompt(
  userPrompt: string,
  files: ResolvedFileAttachment[],
  texts: { name: string; content: string }[]
): string {
  const sections: string[] = []
  if (files.length > 0) {
    const lines = files.map((f) => `- ${f.path}`).join('\n')
    sections.push(`[Attached files]\n${lines}`)
  }
  for (const text of texts) {
    // Fence with a label so multiple text attachments stay distinguishable and
    // the model doesn't confuse them with the instruction.
    sections.push(`[Attached text: ${text.name}]\n\`\`\`\n${text.content}\n\`\`\``)
  }
  if (sections.length === 0) {
    return userPrompt
  }
  const base = userPrompt.trim()
  return `${base ? `${base}\n\n` : ''}${sections.join('\n\n')}`
}

// Image formats vision models accept directly. These attachments are sent to
// jcode via `run --image <localPath>` (read locally, even under --remote-exec)
// instead of being woven into the prompt as a path or copied to the remote host.
const VISION_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** True when a path looks like a vision-readable image. */
export function isVisionImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) {
    return false
  }
  return VISION_IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/** Local paths of image file attachments to pass via `jcode run --image`. */
export function extractImagePaths(attachments: JcodeChatAttachment[]): string[] {
  return attachments
    .filter(
      (a): a is Extract<JcodeChatAttachment, { kind: 'file' }> =>
        a.kind === 'file' && isVisionImagePath(a.path)
    )
    .map((a) => a.path)
}

/** Attachments that still get woven into the prompt — everything EXCEPT vision
 *  images (those go via --image so the model actually sees them). */
export function nonImageAttachments(attachments: JcodeChatAttachment[]): JcodeChatAttachment[] {
  return attachments.filter((a) => !(a.kind === 'file' && isVisionImagePath(a.path)))
}

/** Split a mixed attachment list into file vs text buckets, normalizing names. */
export function partitionAttachments(attachments: JcodeChatAttachment[]): {
  files: { path: string; name: string }[]
  texts: { name: string; content: string }[]
} {
  const files: { path: string; name: string }[] = []
  const texts: { name: string; content: string }[] = []
  for (const attachment of attachments) {
    if (attachment.kind === 'file') {
      files.push({ path: attachment.path, name: attachment.name || basename(attachment.path) })
    } else {
      texts.push({ name: attachment.name || 'text', content: attachment.content })
    }
  }
  return { files, texts }
}

/** Build a unique-ish remote temp directory name for one chat turn's uploads.
 *  Created directly under /tmp so no shared app temp parent can be symlinked. */
export function buildRemoteAttachmentDir(): string {
  return `/tmp/orca-jcode-attachments-${randomUUID()}`
}

/** brain-local (M3) resolution for a chat turn: the remote-exec host (for
 *  `--remote-exec`) and the SSH connectionId backing it (for copying local
 *  attachments to the remote host). `connectionId` is only set when the host was
 *  derived from a workspace SSH target; an ad-hoc `remoteExecHost` override has no
 *  connection to copy through. `remotePath` is the remote project working dir of
 *  the workspace/worktree (used by a later phase to pass `-C <remotePath>` so the
 *  remote bash runs in the project dir); null when unknown or for local turns. */
export type RemoteExecResolution = {
  host: string | null
  connectionId: string | null
  remotePath: string | null
}

export type RemoteAttachmentCleanupTarget = {
  connectionId: string
  remoteDir: string
}

export type ResolvedTurnPrompt = {
  prompt: string
  cleanup: RemoteAttachmentCleanupTarget | null
}

const REMOTE_ATTACHMENT_PREFIX = '/tmp/orca-jcode-attachments-'
const REMOTE_ATTACHMENT_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function safeRemoteAttachmentDir(remoteDir: string): string | null {
  if (remoteDir.includes('\0')) {
    return null
  }
  const normalized = pathPosix.normalize(remoteDir)
  if (normalized !== remoteDir || !normalized.startsWith(REMOTE_ATTACHMENT_PREFIX)) {
    return null
  }
  const suffix = normalized.slice(REMOTE_ATTACHMENT_PREFIX.length)
  return REMOTE_ATTACHMENT_SUFFIX.test(suffix) ? normalized : null
}

/** Per-file size cap for remote attachment transfer. Large files would block the
 *  main process (read + base64) and bloat the SSH channel; refuse them with a
 *  clear note instead. 25 MiB matches the cap surfaced to the user. */
export const MAX_REMOTE_ATTACHMENT_BYTES = 25 * 1024 * 1024

export async function cleanupRemoteAttachmentDir(
  connectionId: string | null | undefined,
  remoteDir: string | null | undefined
): Promise<void> {
  if (!connectionId || !remoteDir) {
    return
  }
  const safeDir = safeRemoteAttachmentDir(remoteDir)
  if (!safeDir) {
    return
  }
  const conn = getLiveSshConnection(connectionId)
  if (!conn) {
    return
  }
  try {
    await runRemoteCommand(conn, `rm -rf -- ${shellQuote(safeDir)}`)
  } catch {
    // Best-effort cleanup must never change the chat result.
  }
}

/** Resolve the final prompt string for a turn by weaving in any attachments.
 *  For LOCAL sessions, file attachments are referenced by their local path. For
 *  remote-exec sessions, each local file is copied to a remote temp dir over the
 *  workspace's live SSH connection and the REMOTE path is referenced instead, so
 *  jcode's remote bash/read tools can see it. If the remote copy can't run (no
 *  live connection / no SFTP transport / read failure) the local file is dropped
 *  from the list and a note is appended so the turn still proceeds honestly. */
export async function resolveTurnPrompt(
  payload: JcodeChatSendPayload,
  remote: RemoteExecResolution
): Promise<ResolvedTurnPrompt> {
  const attachments = payload.attachments ?? []
  if (attachments.length === 0) {
    return { prompt: payload.prompt, cleanup: null }
  }
  const { files, texts } = partitionAttachments(attachments)

  // Local session (or remote with no copyable connection): refer to local paths.
  if (!remote.host || !remote.connectionId) {
    if (remote.host && files.length > 0) {
      // Remote-exec via an ad-hoc host override with no SSH connection to copy
      // through: be honest that local files won't be readable remotely.
      const note = {
        name: 'note',
        content:
          'The following local files could NOT be sent to the remote host (no SSH connection available); ' +
          `they are not readable by the remote agent:\n${files.map((f) => `- ${f.path}`).join('\n')}`
      }
      return {
        prompt: weaveAttachmentsIntoPrompt(payload.prompt, [], [...texts, note]),
        cleanup: null
      }
    }
    return {
      prompt: weaveAttachmentsIntoPrompt(
        payload.prompt,
        files.map((f) => ({ path: f.path, name: f.name })),
        texts
      ),
      cleanup: null
    }
  }

  // Remote-exec session with a live workspace SSH connection: copy each local
  // file to a remote temp dir and reference the remote path.
  const { resolved, failed, oversize, remoteDir } = await copyFilesToRemote(
    files,
    remote.connectionId
  )
  const extraTexts = [...texts]
  if (oversize.length > 0) {
    const capMb = Math.round(MAX_REMOTE_ATTACHMENT_BYTES / (1024 * 1024))
    extraTexts.push({
      name: 'note',
      content:
        `The following files exceed the ${capMb}MB attachment limit and were NOT sent to the ` +
        `remote host:\n${oversize.map((f) => `- ${f.path}`).join('\n')}`
    })
  }
  if (failed.length > 0) {
    extraTexts.push({
      name: 'note',
      content:
        'The following local files could NOT be copied to the remote host and are not readable ' +
        `by the remote agent:\n${failed.map((f) => `- ${f.path}`).join('\n')}`
    })
  }
  return {
    prompt: weaveAttachmentsIntoPrompt(payload.prompt, resolved, extraTexts),
    cleanup: remoteDir ? { connectionId: remote.connectionId, remoteDir } : null
  }
}

/** Copy local files to a fresh remote temp dir over an SSH connection. Returns
 *  resolved remote paths, files that could not be copied (left local), and files
 *  refused for exceeding the size cap.
 *
 *  Binary-safe: we base64-encode the raw bytes locally and decode them on the
 *  remote via `base64 -d`. The previous implementation did
 *  `contents.toString('utf8')` before writeFile, which CORRUPTS any non-UTF8
 *  file (images, PDFs, zips) — invalid byte sequences get replaced with U+FFFD.
 *  Sending base64 over the (text-only) writeFile transport round-trips the exact
 *  bytes regardless of transport (SFTP or system-ssh `cat`). */
async function copyFilesToRemote(
  files: { path: string; name: string }[],
  connectionId: string
): Promise<{
  resolved: ResolvedFileAttachment[]
  failed: { path: string; name: string }[]
  oversize: { path: string; name: string }[]
  remoteDir: string | null
}> {
  const resolved: ResolvedFileAttachment[] = []
  const failed: { path: string; name: string }[] = []
  const oversize: { path: string; name: string }[] = []
  if (files.length === 0) {
    return { resolved, failed, oversize, remoteDir: null }
  }
  const conn = getLiveSshConnection(connectionId)
  if (!conn) {
    return { resolved, failed: [...files], oversize, remoteDir: null }
  }
  const remoteDir = buildRemoteAttachmentDir()
  try {
    await runRemoteCommand(conn, `umask 077 && mkdir -- ${shellQuote(remoteDir)}`)
  } catch {
    return { resolved, failed: [...files], oversize, remoteDir: null }
  }
  for (const file of files) {
    try {
      // Cheap size gate first so an oversized file never gets read into memory.
      const info = await stat(file.path)
      if (info.size > MAX_REMOTE_ATTACHMENT_BYTES) {
        oversize.push(file)
        continue
      }
      const contents = await readFile(file.path)
      const remotePath = `${remoteDir}/${basename(file.path)}`
      // Write base64 to a sidecar file, then decode to the real path on the
      // remote so the bytes are preserved exactly (no utf8 mangling).
      const b64Path = `${remotePath}.b64`
      await conn.writeFile(b64Path, contents.toString('base64'))
      await runRemoteCommand(
        conn,
        `base64 -d ${shellQuote(b64Path)} > ${shellQuote(remotePath)} && rm -f ${shellQuote(b64Path)}`
      )
      resolved.push({ path: remotePath, name: file.name })
    } catch {
      failed.push(file)
    }
  }
  return { resolved, failed, oversize, remoteDir }
}
