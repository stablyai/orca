// Why: SFTP-backed equivalents of `installer-utils.ts` for the remote-install
// flow. Each function takes an `sftp` handle plus paths the agent CLI expects
// on the remote (e.g. `~/.claude/settings.json`). Lives in `agent-hooks/`
// because it shares the contract with the local installer (script body,
// hook-event shape, atomic-rename semantics) and any drift between them is
// exactly the bug we want to avoid.
//
// We deliberately keep the JSON merge logic in the existing
// `installer-utils.ts` and only swap fs primitives — the JSON shape and
// managed-command matching must stay identical to the local install.
//
// See docs/design/agent-status-over-ssh.md §8 (commit #8).

import { randomUUID } from 'crypto'
import type { SFTPWrapper, FileEntryWithStats } from 'ssh2'

import { isPlainObject, type HooksConfig } from './installer-utils'

/** Read+JSON-parse a remote file. Returns `null` on parse failure (caller
 *  surfaces "could not parse" status to the UI), `{}` on missing file
 *  (matches local behavior — first-install case). */
export async function readHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<HooksConfig | null> {
  let body: string
  try {
    body = await readFile(sftp, remotePath)
  } catch (err) {
    if (isNoEntryError(err)) {
      return {}
    }
    return null
  }
  try {
    const parsed = JSON.parse(body)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Atomically write a JSON config to the remote — write to a tmp path then
 *  rename, mirroring the local writeHooksJson contract. The .bak rotation is
 *  intentionally NOT carried over: the remote file is the user's, and a
 *  per-target backup convention belongs alongside the remote installer UI
 *  (out of scope for this commit). */
export async function writeHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  config: HooksConfig
): Promise<void> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  // Why: skip the write when on-disk content is identical so repeated
  // install() calls do not bump the file's mtime / inode unnecessarily.
  try {
    const existing = await readFile(sftp, remotePath)
    if (existing === serialized) {
      return
    }
  } catch {
    // ENOENT or read error — fall through to the write below.
  }
  // Why: tmp + rename so a partial network drop mid-write does not leave a
  // truncated settings.json that the agent CLI would refuse to load.
  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    await writeFile(sftp, tmp, serialized)
    await rename(sftp, tmp, remotePath)
  } finally {
    // Best-effort cleanup if rename failed.
    try {
      await unlink(sftp, tmp)
    } catch {
      // already gone or never created
    }
  }
}

/** Write the managed hook script to the remote and chmod 0o755. POSIX-only —
 *  the relay deliberately does not support Windows-remote in v1 (see design
 *  doc §3 + §6). */
export async function writeManagedScriptRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  await mkdirpRemote(sftp, dirnamePosix(remotePath))
  await writeFile(sftp, remotePath, content)
  await chmod(sftp, remotePath, 0o755)
}

// ─── Private SFTP primitives ────────────────────────────────────────

async function readFile(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sftp.readFile(remotePath, 'utf8', (err, data) => {
      if (err) {
        reject(err)
        return
      }
      resolve(typeof data === 'string' ? data : data.toString('utf8'))
    })
  })
}

async function writeFile(sftp: SFTPWrapper, remotePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, content, 'utf8', (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

async function rename(sftp: SFTPWrapper, src: string, dst: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(src, dst, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

async function unlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

async function chmod(sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(remotePath, mode, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

async function readdir(sftp: SFTPWrapper, remotePath: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        reject(err)
        return
      }
      resolve(list)
    })
  })
}

async function mkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => {
      if (err) {
        // SSH_FX_FAILURE (4) often means "already exists" on OpenSSH; we
        // probe with stat afterwards rather than parse the error code.
        reject(err)
        return
      }
      resolve()
    })
  })
}

async function mkdirpRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  if (remotePath === '/' || remotePath === '' || remotePath === '.') {
    return
  }
  // Why: walk the path top-down rather than bottom-up so an existing parent
  // chain doesn't cost a full readdir per segment. POSIX-only — Windows-
  // remote is out of scope for v1.
  const segments = remotePath.split('/').filter((s) => s.length > 0)
  let current = remotePath.startsWith('/') ? '' : '.'
  for (const seg of segments) {
    current = current === '' ? `/${seg}` : current === '.' ? seg : `${current}/${seg}`
    try {
      await readdir(sftp, current)
    } catch {
      try {
        await mkdir(sftp, current)
      } catch (err) {
        // Why: re-raise only when the dir really isn't there. SSH_FX_FAILURE
        // on a concurrent mkdir from another client is harmless — readdir on
        // the next iteration will succeed.
        if (!isAlreadyExistsError(err)) {
          throw err
        }
      }
    }
  }
}

function dirnamePosix(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) {
    return idx === 0 ? '/' : '.'
  }
  return p.slice(0, idx)
}

function isNoEntryError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  // ssh2 surfaces SFTP errors with `code === 2` (SSH_FX_NO_SUCH_FILE).
  return (err as { code?: unknown }).code === 2
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  // SSH_FX_FAILURE (4) is OpenSSH's catch-all for "exists" alongside other
  // mkdir failures; we accept the ambiguity and let the next readdir prove
  // success.
  return (err as { code?: unknown }).code === 4
}
