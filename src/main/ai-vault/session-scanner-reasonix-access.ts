import { createHash } from 'node:crypto'
import { reasonixSessionLayout } from '../../shared/reasonix-session-paths'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'
import type { ReasonixContentReader } from './session-scanner-reasonix-projection'
import { asRecord } from './session-scanner-values'
import { resolveReasonixWorkspace } from './session-scanner-reasonix-workspace'
import {
  parseReasonixManifest,
  parseReasonixWorkspaceHeader
} from './session-scanner-reasonix-metadata'

export type ReasonixHistoryAccess = {
  createdAt: string
  cwd: string | null
  metadataKey: string
  readContent: ReasonixContentReader
}

// The execution-host adapter must lstat; client filesystem RPC has no byte capability.
export async function reasonixHistoryAccess(
  provider: Pick<RemoteSessionFilesystemProvider, 'stat' | 'readTranscriptBytes'>,
  platform: RemoteHostPlatform,
  transcriptPath: string,
  signal?: AbortSignal,
  workspaceRoots: readonly string[] = []
): Promise<ReasonixHistoryAccess> {
  const layout = reasonixSessionLayout(transcriptPath)
  const read = provider.readTranscriptBytes
  if (!layout || !read) {
    throw new Error('Reasonix history requires execution-host byte reads')
  }
  const readBytes = read
  const join = (...segments: string[]) => joinRemotePath(platform, ...segments)
  async function directory(path: string): Promise<void> {
    signal?.throwIfAborted()
    if ((await provider.stat(path))?.type !== 'directory') {
      throw new Error('Reasonix history directory is missing or not a regular directory')
    }
  }
  async function readFile(path: string, budget: number, optional = false): Promise<Buffer | null> {
    signal?.throwIfAborted()
    let stat
    try {
      stat = await provider.stat(path)
    } catch (error) {
      if (optional && isMissingRemoteSessionPathError(error)) {
        return null
      }
      throw error
    }
    if (!stat && optional) {
      return null
    }
    if (
      !stat ||
      stat.type !== 'file' ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > budget
    ) {
      throw new Error('Reasonix history object is missing, not regular, or exceeds read budget')
    }
    const chunks: Buffer[] = []
    let length = 0
    for await (const bytes of readBytes(path, signal)) {
      signal?.throwIfAborted()
      length += bytes.length
      if (length > budget || length > stat.size) {
        throw new Error('Reasonix history object changed or exceeds read budget')
      }
      chunks.push(bytes)
    }
    if (length !== stat.size) {
      throw new Error('Reasonix history object changed during read')
    }
    return Buffer.concat(chunks, length)
  }
  await directory(join(layout.stateHome, 'projects'))
  await directory(layout.projectDirectory)
  await directory(join(layout.projectDirectory, 'sessions-v4'))
  await directory(layout.sessionDirectory)
  const transcriptStat = await provider.stat(transcriptPath)
  if (transcriptStat?.type !== 'file') {
    throw new Error('Reasonix transcript is missing or not a regular file')
  }
  const manifestBytes = await readFile(join(layout.sessionDirectory, 'manifest.json'), 64 * 1024)
  if (!manifestBytes) {
    throw new Error('Reasonix manifest is missing')
  }
  const manifest = parseReasonixManifest(manifestBytes, layout.sessionId)
  const headerBytes = await readFile(join(layout.sessionDirectory, 'header.json'), 64 * 1024, true)
  const headerCwd = headerBytes ? parseReasonixWorkspaceHeader(headerBytes, layout.sessionId) : null
  const marker = await readFile(join(layout.projectDirectory, '.workspace-root'), 4096, true)
  const desktopBytes = await readFile(
    join(layout.stateHome, 'desktop-projects.json'),
    128 * 1024,
    true
  )
  let desktopRoots: string[] = []
  if (desktopBytes) {
    const value: unknown = JSON.parse(desktopBytes.toString('utf8'))
    const projects = asRecord(value)?.projects
    if (!Array.isArray(projects) || projects.length > 1024) {
      throw new Error('Invalid Reasonix desktop project inventory')
    }
    desktopRoots = projects.map((project) => {
      const root = asRecord(project)?.root
      if (typeof root !== 'string') {
        throw new Error('Invalid Reasonix desktop project root')
      }
      return root
    })
  }
  const projectCwd = resolveReasonixWorkspace(
    layout,
    platform,
    [...workspaceRoots, ...desktopRoots],
    marker
  )
  if (headerCwd && projectCwd && headerCwd !== projectCwd) {
    throw new Error('Conflicting Reasonix workspace ownership')
  }
  const cwd = headerCwd ?? projectCwd
  const contentRoot =
    manifest.contentRoot === '.content-v1'
      ? join(layout.sessionDirectory, '.content-v1')
      : join(layout.projectDirectory, 'sessions-v4', '.content-v1')
  return {
    createdAt: manifest.createdAt,
    cwd,
    metadataKey: createHash('sha256')
      .update(
        JSON.stringify([
          manifestBytes.toString('base64'),
          headerBytes?.toString('base64'),
          marker?.toString('base64'),
          desktopBytes?.toString('base64'),
          cwd
        ])
      )
      .digest('hex'),
    readContent: async (digest, size) => {
      if (
        !/^[a-f0-9]{64}$/.test(digest) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 8 * 1024 * 1024
      ) {
        throw new Error('Invalid Reasonix content object identity')
      }
      const parents = [
        contentRoot,
        join(contentRoot, 'objects'),
        join(contentRoot, 'objects', digest.slice(0, 2)),
        join(contentRoot, 'objects', digest.slice(0, 2), digest.slice(2, 4))
      ]
      for (const parent of parents) {
        await directory(parent)
      }
      const content = await readFile(join(parents[3], digest), size)
      if (!content || content.length !== size) {
        throw new Error('Reasonix content object length mismatch')
      }
      return content
    }
  }
}
