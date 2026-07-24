// Guest-side fs bridge for the WSL agent-hook relay. Exposes the handful of
// home-scoped file operations the shared remote hook installers need, as
// JSON-RPC request handlers over the relay's stdio channel — so the host
// installs hook configs/scripts into the distro without per-file wsl.exe
// spawns (load-sensitive, see docs/agent-status-over-wsl.md).
import { promises as fs } from 'node:fs'
import { posix } from 'node:path'

import type { RelayDispatcher } from './dispatcher'
import {
  createFilesystemDirectoryLimitState,
  trackFilesystemDirectoryEntry
} from '../shared/filesystem-directory-listing-limit'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../shared/node-bounded-file-reader'
import {
  WSL_HOOK_FS_METHODS,
  WSL_HOOK_FS_MAX_DIRECTORY_ENTRIES,
  WSL_HOOK_FS_MAX_DIRECTORY_RETAINED_BYTES,
  WSL_HOOK_FS_MAX_READ_BYTES,
  type WslFsFailure,
  type WslFsResult
} from '../shared/wsl-hook-relay-contract'

function failure(err: unknown): WslFsFailure {
  if (err instanceof NodeFileReadTooLargeError) {
    return {
      ok: false,
      errno: 'EFBIG',
      message: err.message,
      fileCapacity: { observedBytes: err.observedBytes, maxBytes: err.maxBytes }
    }
  }
  const e = err as NodeJS.ErrnoException
  return { ok: false, errno: e?.code ?? 'EUNKNOWN', message: e?.message ?? String(err) }
}

function requestedLimit(value: unknown, maximum: number): number {
  if (value === undefined) {
    return maximum
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error('invalid capacity limit'), { code: 'EINVAL' })
  }
  return Math.min(value, maximum)
}

function requestedDirectoryLimit(value: unknown, maximum: number): number {
  const limit = requestedLimit(value, maximum)
  if (limit === 0) {
    throw Object.assign(new Error('directory capacity limit must be positive'), { code: 'EINVAL' })
  }
  return limit
}

export function registerWslHookFsHandlers(
  dispatcher: RelayDispatcher,
  home: string,
  // Why: the home request doubles as the connect handshake; link diagnostics
  // (port fallback) ride it so the host can breadcrumb them.
  linkStatus?: () => Record<string, unknown>
): void {
  // Why: the bridge exists solely to write agent hook configs into the guest
  // user's home. Refusing paths outside it bounds the blast radius of a
  // compromised host-side caller to what hook installation touches anyway.
  // The bound is lexical (symlinks inside home are followed) — acceptable
  // because the only caller is the host-owned stdio channel, never an
  // agent-reachable surface.
  const homeRoot = posix.resolve(home)
  const resolveRaw = (rawPath: unknown): string => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw Object.assign(new Error('invalid path'), { code: 'EINVAL' })
    }
    return posix.resolve(rawPath)
  }
  const scoped = (rawPath: unknown): string => {
    const resolved = resolveRaw(rawPath)
    if (resolved !== homeRoot && !resolved.startsWith(`${homeRoot}/`)) {
      throw Object.assign(new Error(`path outside home: ${resolved}`), { code: 'EACCES' })
    }
    return resolved
  }
  // Why: the installers' mkdir-p walks top-down from `/`, probing every
  // ancestor of home before it ever creates a dir. Allow
  // read-only existence probes on those ancestors; everything else stays
  // home-scoped.
  const scopedProbe = (rawPath: unknown): string => {
    const resolved = resolveRaw(rawPath)
    if (resolved === '/' || homeRoot === resolved || homeRoot.startsWith(`${resolved}/`)) {
      return resolved
    }
    return scoped(rawPath)
  }

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.home,
    async (): Promise<WslFsResult<{ home: string }>> => {
      return { ok: true, home: homeRoot, ...linkStatus?.() }
    }
  )

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.readFile,
    async (params): Promise<WslFsResult<{ content: string }>> => {
      try {
        const maxBytes = requestedLimit(params.maxBytes, WSL_HOOK_FS_MAX_READ_BYTES)
        const content = (
          await readNodeFileWithinLimit(scoped(params.path), maxBytes)
        ).buffer.toString('utf8')
        return { ok: true, content }
      } catch (err) {
        return failure(err)
      }
    }
  )

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.writeFile, async (params): Promise<WslFsResult> => {
    try {
      const mode = typeof params.mode === 'number' ? params.mode : undefined
      await fs.writeFile(scoped(params.path), String(params.content ?? ''), {
        encoding: 'utf8',
        mode
      })
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.stat,
    async (params): Promise<WslFsResult<{ mode: number }>> => {
      try {
        const stats = await fs.stat(scopedProbe(params.path))
        return { ok: true, mode: stats.mode }
      } catch (err) {
        return failure(err)
      }
    }
  )

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.rename, async (params): Promise<WslFsResult> => {
    try {
      // Why: POSIX rename overwrites atomically — exactly the OpenSSH
      // overwrite-rename semantics the installers prefer.
      await fs.rename(scoped(params.src), scoped(params.dst))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.unlink, async (params): Promise<WslFsResult> => {
    try {
      await fs.unlink(scoped(params.path))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.chmod, async (params): Promise<WslFsResult> => {
    try {
      await fs.chmod(scoped(params.path), Number(params.mode))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.readdir,
    async (params): Promise<WslFsResult<{ entries: { filename: string }[] }>> => {
      let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined
      try {
        const limits = {
          maxEntries: requestedDirectoryLimit(params.maxEntries, WSL_HOOK_FS_MAX_DIRECTORY_ENTRIES),
          maxRetainedBytes: requestedDirectoryLimit(
            params.maxRetainedBytes,
            WSL_HOOK_FS_MAX_DIRECTORY_RETAINED_BYTES
          )
        }
        const limit = createFilesystemDirectoryLimitState(limits)
        const entries: { filename: string }[] = []
        const directoryPath = scopedProbe(params.path)
        directory = await fs.opendir(directoryPath, { bufferSize: 32 })
        // Ancestors outside home are authorized only as existence probes.
        if (
          directoryPath !== homeRoot &&
          (directoryPath === '/' || homeRoot.startsWith(`${directoryPath}/`))
        ) {
          return { ok: true, entries }
        }
        for (;;) {
          const entry = await directory.read()
          if (entry === null) {
            break
          }
          trackFilesystemDirectoryEntry(limit, { name: entry.name })
          entries.push({ filename: entry.name })
        }
        return { ok: true, entries }
      } catch (err) {
        return failure(err)
      } finally {
        await directory?.close().catch(() => undefined)
      }
    }
  )

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.mkdir, async (params): Promise<WslFsResult> => {
    try {
      await fs.mkdir(scoped(params.path))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
}
