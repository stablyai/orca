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
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { JcodeChatAttachment, JcodeChatSendPayload } from '../../shared/jcode-chat-types'
import { getSshConnectionManager } from '../ipc/ssh'

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
 *  Kept short + filesystem-safe; uniqueness comes from the timestamp + random. */
export function buildRemoteAttachmentDir(): string {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `/tmp/orca-jcode-attachments/${stamp}-${rand}`
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

/** Minimal single-quote shell escaping for a POSIX path argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Per-file size cap for remote attachment transfer. Large files would block the
 *  main process (read + base64) and bloat the SSH channel; refuse them with a
 *  clear note instead. 25 MiB matches the cap surfaced to the user. */
export const MAX_REMOTE_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Run a remote command over an SSH connection and resolve when it closes.
 *  Best-effort: rejects only on channel-open failure. */
function runRemoteCommand(
  conn: NonNullable<
    ReturnType<NonNullable<ReturnType<typeof getSshConnectionManager>>['getConnection']>
  >,
  command: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    conn
      .exec(command)
      .then((channel) => {
        channel.on('close', () => resolve())
        channel.on('error', (err: Error) => reject(err))
        // Drain so the channel can close.
        channel.on('data', () => {})
        channel.stderr?.on('data', () => {})
      })
      .catch(reject)
  })
}

/** A live SSH connection object (as returned by the connection manager). */
export type SshConnection = NonNullable<
  ReturnType<NonNullable<ReturnType<typeof getSshConnectionManager>>['getConnection']>
>

/** Resolve a live, connected SSH connection by id, or null. Shared by the skill
 *  discovery module so it can read remote `.claude/skills` over the same SSH
 *  transport that attachment copying uses. */
export function getLiveSshConnection(connectionId: string): SshConnection | null {
  const conn = getSshConnectionManager()?.getConnection(connectionId)
  if (!conn || conn.getState().status !== 'connected') {
    return null
  }
  return conn
}

/** Run a remote command over SSH and CAPTURE its stdout (unlike runRemoteCommand,
 *  which discards output). Resolves with the accumulated stdout on a zero exit;
 *  resolves with null on any non-zero/failed exit so callers can treat a missing
 *  file or directory as "no skills here" rather than throwing. Best-effort, with
 *  a bound so a hung channel can't stall skill discovery forever. */
export function runRemoteCapture(conn: SshConnection, command: string): Promise<string | null> {
  const TIMEOUT_MS = 10_000
  return new Promise((resolve) => {
    conn
      .exec(command)
      .then((channel) => {
        let stdout = ''
        let exitCode: number | null = null
        let settled = false
        const finish = (value: string | null): void => {
          if (settled) {
            return
          }
          settled = true
          if (timer) {
            clearTimeout(timer)
          }
          resolve(value)
        }
        const timer = setTimeout(() => finish(null), TIMEOUT_MS)
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
        channel.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        channel.stderr?.on('data', () => {})
        channel.on('exit', (code: number | null) => {
          exitCode = code
        })
        channel.on('close', () => finish(exitCode === 0 ? stdout : null))
        channel.on('error', () => finish(null))
        channel.stderr?.on('error', () => {})
      })
      .catch(() => resolve(null))
  })
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
): Promise<string> {
  const attachments = payload.attachments ?? []
  if (attachments.length === 0) {
    return payload.prompt
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
      return weaveAttachmentsIntoPrompt(payload.prompt, [], [...texts, note])
    }
    return weaveAttachmentsIntoPrompt(
      payload.prompt,
      files.map((f) => ({ path: f.path, name: f.name })),
      texts
    )
  }

  // Remote-exec session with a live workspace SSH connection: copy each local
  // file to a remote temp dir and reference the remote path.
  const { resolved, failed, oversize } = await copyFilesToRemote(files, remote.connectionId)
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
  return weaveAttachmentsIntoPrompt(payload.prompt, resolved, extraTexts)
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
}> {
  const resolved: ResolvedFileAttachment[] = []
  const failed: { path: string; name: string }[] = []
  const oversize: { path: string; name: string }[] = []
  if (files.length === 0) {
    return { resolved, failed, oversize }
  }
  const conn = getSshConnectionManager()?.getConnection(connectionId)
  if (!conn || conn.getState().status !== 'connected') {
    return { resolved, failed: [...files], oversize }
  }
  const remoteDir = buildRemoteAttachmentDir()
  try {
    await runRemoteCommand(conn, `mkdir -p ${shellQuote(remoteDir)}`)
  } catch {
    return { resolved, failed: [...files], oversize }
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
  return { resolved, failed, oversize }
}
