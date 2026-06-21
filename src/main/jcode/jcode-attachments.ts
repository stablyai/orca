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
import { readFile } from 'node:fs/promises'
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
 *  connection to copy through. */
export type RemoteExecResolution = { host: string | null; connectionId: string | null }

/** Minimal single-quote shell escaping for a POSIX path argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

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
  const { resolved, failed } = await copyFilesToRemote(files, remote.connectionId)
  const extraTexts = [...texts]
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
 *  resolved remote paths and any files that could not be copied (left local). */
async function copyFilesToRemote(
  files: { path: string; name: string }[],
  connectionId: string
): Promise<{ resolved: ResolvedFileAttachment[]; failed: { path: string; name: string }[] }> {
  const resolved: ResolvedFileAttachment[] = []
  const failed: { path: string; name: string }[] = []
  if (files.length === 0) {
    return { resolved, failed }
  }
  const conn = getSshConnectionManager()?.getConnection(connectionId)
  if (!conn || conn.getState().status !== 'connected') {
    return { resolved, failed: [...files] }
  }
  const remoteDir = buildRemoteAttachmentDir()
  try {
    await runRemoteCommand(conn, `mkdir -p ${shellQuote(remoteDir)}`)
  } catch {
    return { resolved, failed: [...files] }
  }
  for (const file of files) {
    try {
      const contents = await readFile(file.path)
      const remotePath = `${remoteDir}/${basename(file.path)}`
      await conn.writeFile(remotePath, contents.toString('utf8'))
      resolved.push({ path: remotePath, name: file.name })
    } catch {
      failed.push(file)
    }
  }
  return { resolved, failed }
}
