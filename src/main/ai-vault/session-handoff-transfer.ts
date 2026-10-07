import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from '../providers/types'
import { resolveRemoteHomeDirectory } from '../remote-home-directory'
import { AI_VAULT_HANDOFF_MAX_TRANSFER_BYTES } from '../../shared/ai-vault-session-handoff'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

const HANDOFF_DIGEST_TAIL_BYTES = 256 * 1024
const HANDOFF_CHUNK_BYTES = 512 * 1024
const NUL = String.fromCharCode(0)

export type AiVaultSessionHandoffArgs = {
  agent: string
  sessionId: string
  sourceFilePath: string
  sourceConnectionId: string | null
  targetConnectionId: string | null
  deliver?: 'file' | 'text'
}

export type AiVaultSessionHandoffResult =
  /** The transcript now exists on the target host at `transcriptPath`. */
  | { kind: 'transferred'; transcriptPath: string; byteLength: number }
  /** Too large to move, so only a bounded tail of the transcript travels. */
  | { kind: 'digest'; text: string; byteLength: number; omittedBytes: number }
  | { kind: 'unsupported'; reason: AiVaultSessionHandoffUnsupportedReason }

export type AiVaultSessionHandoffUnsupportedReason =
  | 'binary-transcript'
  | 'source-unavailable'
  | 'target-unavailable'

async function readSourceSize(
  sourceFilePath: string,
  provider: IFilesystemProvider | null
): Promise<number> {
  return provider ? (await provider.stat(sourceFilePath)).size : (await stat(sourceFilePath)).size
}

async function readWholeSource(args: {
  sourceFilePath: string
  provider: IFilesystemProvider | null
  byteLength: number
}): Promise<{ content: string; isBinary: boolean }> {
  if (args.provider) {
    const result = await args.provider.readFile(args.sourceFilePath, {
      maxTextBytes: args.byteLength
    })
    return { content: result.content, isBinary: result.isBinary }
  }
  const content = await readFile(args.sourceFilePath, 'utf-8')
  return { content, isBinary: content.includes(NUL) }
}

/** Newest bytes only; the tail is where the unfinished work lives. */
async function readSourceTail(args: {
  sourceFilePath: string
  provider: IFilesystemProvider | null
  byteLength: number
}): Promise<string | null> {
  const position = Math.max(0, args.byteLength - HANDOFF_DIGEST_TAIL_BYTES)
  if (!args.provider) {
    const buffer = await readFile(args.sourceFilePath)
    return buffer.subarray(position).toString('utf-8')
  }
  if (!args.provider.readFileRange) {
    return null
  }
  const range = await args.provider.readFileRange(
    args.sourceFilePath,
    position,
    args.byteLength - position
  )
  return range.bytes.subarray(0, range.bytesRead).toString('utf-8')
}

async function resolveTargetDirectory(
  targetConnectionId: string | null
): Promise<{ directory: string; provider: IFilesystemProvider | null } | null> {
  if (!targetConnectionId) {
    return { directory: join(homedir(), '.orca', 'handoffs'), provider: null }
  }
  const provider = getSshFilesystemProvider(targetConnectionId)
  const home = await resolveRemoteHomeDirectory(targetConnectionId)
  // Why: remote hosts are POSIX-only here, matching the remote agent-hook installs.
  if (!provider || !home || isWindowsAbsolutePathLike(home)) {
    return null
  }
  return { directory: `${home}/.orca/handoffs`, provider }
}

/** Session ids are provider-issued; keep only characters that are safe in a path segment. */
function toHandoffFileName(agent: string, sessionId: string, sourceFilePath: string): string {
  const safeAgent = agent.replace(/[^A-Za-z0-9_-]/g, '') || 'agent'
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '') || 'session'
  const extension = extname(sourceFilePath).replace(/[^A-Za-z0-9.]/g, '') || '.txt'
  return `${safeAgent}-${safeSessionId}${extension}`
}

async function writeTranscript(args: {
  provider: IFilesystemProvider | null
  directory: string
  filePath: string
  content: string
}): Promise<void> {
  if (!args.provider) {
    await mkdir(dirname(args.filePath), { recursive: true })
    await writeFile(args.filePath, args.content, 'utf-8')
    return
  }
  await args.provider.createDir(args.directory)
  const buffer = Buffer.from(args.content, 'utf-8')
  // Why: one multi-megabyte request can exceed the relay frame budget, so append in chunks.
  for (let offset = 0; offset < buffer.byteLength; offset += HANDOFF_CHUNK_BYTES) {
    const chunk = buffer.subarray(offset, offset + HANDOFF_CHUNK_BYTES)
    await args.provider.writeFileBase64Chunk(args.filePath, chunk.toString('base64'), offset > 0)
  }
}

/**
 * Make a prior session's transcript readable by an agent starting on another
 * host. Continuation needs the transcript text, not the provider session, so a
 * copy on the target host serves both context modes unchanged.
 */
export async function prepareAiVaultSessionHandoff(
  args: AiVaultSessionHandoffArgs
): Promise<AiVaultSessionHandoffResult> {
  const sourceProvider = args.sourceConnectionId
    ? (getSshFilesystemProvider(args.sourceConnectionId) ?? null)
    : null
  if (args.sourceConnectionId && !sourceProvider) {
    return { kind: 'unsupported', reason: 'source-unavailable' }
  }

  const byteLength = await readSourceSize(args.sourceFilePath, sourceProvider)

  // Why: a target that accepts no file still gets the real transcript, just
  // bounded and carried in the prompt rather than copied over.
  if (args.deliver === 'text' || byteLength > AI_VAULT_HANDOFF_MAX_TRANSFER_BYTES) {
    const text = await readSourceTail({
      sourceFilePath: args.sourceFilePath,
      provider: sourceProvider,
      byteLength
    })
    if (text === null) {
      return { kind: 'unsupported', reason: 'source-unavailable' }
    }
    return {
      kind: 'digest',
      text,
      byteLength,
      omittedBytes: Math.max(0, byteLength - HANDOFF_DIGEST_TAIL_BYTES)
    }
  }

  const source = await readWholeSource({
    sourceFilePath: args.sourceFilePath,
    provider: sourceProvider,
    byteLength
  })
  if (source.isBinary) {
    // Why: SQLite-backed session stores (OpenCode) are not a readable transcript.
    return { kind: 'unsupported', reason: 'binary-transcript' }
  }

  const target = await resolveTargetDirectory(args.targetConnectionId)
  if (!target) {
    return { kind: 'unsupported', reason: 'target-unavailable' }
  }

  const fileName = toHandoffFileName(args.agent, args.sessionId, args.sourceFilePath)
  const transcriptPath = target.provider
    ? `${target.directory}/${fileName}`
    : join(target.directory, fileName)
  await writeTranscript({
    provider: target.provider,
    directory: target.directory,
    filePath: transcriptPath,
    content: source.content
  })
  return { kind: 'transferred', transcriptPath, byteLength }
}
