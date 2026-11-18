// The files a bot's connector verbs carry, moved here, straight between this machine and the source:
// one it attaches goes from disk to the source's upload URL, and one it downloads comes from Orca
// Cloud's stream to disk. Neither passes through the host as bytes, and Orca sets no size cap.
import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { open, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import { RuntimeClientError } from '../runtime/connection/types'

/** A file to attach, as found where the bot's agent named it; its bytes are read only to send them. */
export type LocalFile = { path: string; name: string; size: number }

/** A downloaded file: where to stream its bytes from and the ticket to show (`slack read
 *  --download`), or its bytes inline as base64 (Google's, which ride inside one host request). */
export type DownloadedFile = {
  id: string
  name: string
  size?: number
  url?: string
  ticket?: string
  data?: string
}

type Fetch = typeof fetch

// A forwarded shell's files are on another machine, out of this process's reach.
export function refuseForwardedShell(): void {
  if (process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_environment',
      "This shell forwards orca to another machine, whose files this command can't reach. Run it from a shell on the machine that has them."
    )
  }
}

/** The file to attach, found here, where the bot's agent named it. */
export async function localFile(cwd: string, path: string): Promise<LocalFile> {
  refuseForwardedShell()
  const file = resolve(cwd, path)
  // A pipe or device has no size to cut an upload slot for, and opening a pipe waits for a writer.
  const found = await stat(file).catch((error: unknown) => {
    throw error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? new RuntimeClientError('invalid_argument', `${path} doesn't exist.`)
      : error
  })
  if (!found.isFile()) {
    throw new RuntimeClientError('invalid_argument', `${basename(file)} isn't a file.`)
  }
  return { path: file, name: basename(file), size: found.size }
}

/** What stage asks for: a slot of exactly this file's size. */
export const uploadArgs = (file: LocalFile): Pick<ConnectorActionArgs, 'upload' | 'stage'> => ({
  upload: { name: file.name, size: file.size },
  stage: true
})

const UPLOAD_FAILED = (name: string) =>
  new RuntimeClientError(
    'upload_failed',
    `Slack didn't take ${name}; nothing was posted. Try again in a moment.`
  )

/** The file's bytes to the source's upload URL, read from disk as they go; the URL itself is the
 *  credential, so nothing else is sent. A file that changed size since staging is refused, as the
 *  slot was cut for the old size. */
export async function uploadFile(
  url: string,
  file: LocalFile,
  request: Fetch = (input, init) => fetch(input, init)
): Promise<void> {
  const blob = await openAsBlob(file.path)
  if (blob.size !== file.size) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${file.name} changed while it was being sent; nothing was posted. Send it again.`
    )
  }
  let response: Response
  try {
    response = await request(url, { method: 'POST', body: blob })
  } catch {
    throw UPLOAD_FAILED(file.name)
  }
  await response.body?.cancel().catch(() => {})
  if (!response.ok) {
    throw UPLOAD_FAILED(file.name)
  }
}

/** The path a download is saved to: where the bot asked, or beside it under its own name. */
function downloadPath(cwd: string, out: string | undefined, file: DownloadedFile): string {
  // No control characters, and none Windows refuses in a name.
  const name = basename(
    [...file.name].map((char) => (char < ' ' || '<>:"|?*'.includes(char) ? '_' : char)).join('')
  )
  return resolve(cwd, out ?? (name === '.' || name === '..' ? file.id : name))
}

// Orca Cloud's own answers when it can't stream the file, as `{ error, message }`.
const DownloadErrorSchema = (body: unknown): { error: string; message?: string } | null =>
  body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? {
        error: body.error,
        ...('message' in body && typeof body.message === 'string' ? { message: body.message } : {})
      }
    : null

async function downloadRefusal(response: Response, name: string): Promise<RuntimeClientError> {
  const body = DownloadErrorSchema(await response.json().catch(() => null))
  if (body?.message) {
    return new RuntimeClientError(body.error, body.message)
  }
  return response.status === 401 || response.status === 403
    ? new RuntimeClientError(
        'download_expired',
        `The link to ${name} expired; run the same \`orca slack read --download\` again.`
      )
    : new RuntimeClientError(
        'unavailable',
        `Slack didn't send ${name}; nothing was saved. Try again in a moment.`
      )
}

/** A downloaded file, streamed from Orca Cloud to where the bot asked or beside it under its own
 *  name; never over a file, and never left half-written. Orca Cloud passes Slack's bytes through as
 *  they come; when the stream breaks off (a long download outlives one request), the rest is asked
 *  for from where it stopped, for as long as each try brings more. */
export async function saveDownload(
  cwd: string,
  out: string | undefined,
  file: DownloadedFile,
  request: Fetch = (input, init) => fetch(input, init)
): Promise<string> {
  if (file.data !== undefined) {
    return await saveInline(downloadPath(cwd, out, file), file.data)
  }
  if (!file.url || !file.ticket) {
    throw new RuntimeClientError(
      'cloud_lacks_direct_files',
      "Orca Cloud didn't send a link to the file; update Orca and try again."
    )
  }
  const path = downloadPath(cwd, out, file)
  const handle = await open(path, 'wx').catch(refuseExisting(path))
  let saved = false
  try {
    let written = 0
    let expected: number | undefined = file.size
    for (;;) {
      const response = await request(file.url, {
        headers: {
          authorization: `Bearer ${file.ticket}`,
          ...(written > 0 ? { range: `bytes=${written}-` } : {})
        }
      }).catch(() => null)
      if (!response) {
        if (written > 0) {
          throw brokeOff(file.name, written)
        }
        throw new RuntimeClientError(
          'unavailable',
          "Orca Cloud didn't answer; nothing was saved. Try again in a moment."
        )
      }
      if (!response.ok || !response.body) {
        throw await downloadRefusal(response, file.name)
      }
      // A resumed try must start where the last stopped; a whole file again can't be appended.
      if (written > 0 && response.status !== 206) {
        await response.body.cancel().catch(() => {})
        throw brokeOff(file.name, written)
      }
      const total = Number(response.headers.get('x-orca-file-size') ?? Number.NaN)
      if (Number.isSafeInteger(total)) {
        expected = total
      }
      const before = written
      let ended = false
      try {
        for await (const chunk of response.body) {
          await handle.write(chunk)
          written += chunk.length
        }
        ended = true
      } catch {
        // Broken off; asked again from here below, if this try brought anything.
      }
      if (ended && (expected === undefined || written >= expected)) {
        break
      }
      if (written === before) {
        throw brokeOff(file.name, written)
      }
    }
    saved = true
    return path
  } finally {
    await handle.close()
    if (!saved) {
      await unlink(path).catch(() => {})
    }
  }
}

const refuseExisting = (path: string) => (error: unknown) => {
  throw error instanceof Error && 'code' in error && error.code === 'EEXIST'
    ? new RuntimeClientError(
        'invalid_argument',
        `${path} already exists; pass --out with a new path.`
      )
    : error
}

async function saveInline(path: string, data: string): Promise<string> {
  await writeFile(path, Buffer.from(data, 'base64'), { flag: 'wx' }).catch(refuseExisting(path))
  return path
}

/** A file read whole into one host request as base64 (Google's uploads and draft attachments, which
 *  ride inside a paired server's request), up to what that request leaves room for. */
export async function attachedFile(
  cwd: string,
  path: string,
  limit: { maxBytes: number; verb: string }
): Promise<{ name: string; data: string }> {
  const file = await localFile(cwd, path)
  const handle = await open(file.path, 'r')
  try {
    // One byte past the cap tells a file that grew since; the stat size isn't trusted.
    const buffer = Buffer.alloc(limit.maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length)
      if (bytesRead === 0) {
        break
      }
      length += bytesRead
    }
    if (length > limit.maxBytes) {
      throw new RuntimeClientError(
        'invalid_argument',
        `${file.name} is too large; ${limit.verb} takes up to ${Math.floor(limit.maxBytes / 1024)} KB.`
      )
    }
    return { name: file.name, data: buffer.subarray(0, length).toString('base64') }
  } finally {
    await handle.close()
  }
}

const brokeOff = (name: string, written: number) =>
  new RuntimeClientError(
    'unavailable',
    `The download of ${name} broke off after ${written} bytes; nothing was saved. Try again in a moment.`
  )

/** A fresh postId for each file and post: the host's retries after a lost answer then find the
 *  first instead of making another. */
export const newPostId = (): string => randomUUID()
