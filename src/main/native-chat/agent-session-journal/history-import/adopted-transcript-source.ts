import { createReadStream } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { sessionIdFromFileName } from '../../../ai-vault/parsing/session-scanner-accumulator'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/file-access/cross-platform-path'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import { extractString } from '../../../../shared/text/trimmed-string'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'

import { parseHermesSqliteSessionViaWorker } from '../../../ai-vault/scanners/hermes/session-scanner-hermes-worker'
import { readOpenCodeTranscriptSignalViaWorker } from '../../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn'
import { samePiDirectory } from '../../../pi/rpc/launch/rpc-launch-resolution'
import { admitTranscriptPath } from '../../transcript-discovery/transcript-path-admission'
import { adoptedDirectoryProbes } from './adopted-directory-probe'
import {
  encodeClaudeProjectPaths,
  isClaudeProjectOwnBucketName
} from '../../../ai-vault/scanners/claude/claude-project-dir-encoding'
import { grokEncodedCwdDirName } from '../../../../shared/agent-hook-listener/providers/grok/grok-session-paths'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat/native-chat-agent-support'
import { decodeTranscriptStream } from '../../transcript-streaming/transcript-stream-lines'

export type AdoptedTranscriptSource = {
  providerSessionId: string
  workspaceCwd: string
  /** Host-selected account store, never supplied by a wire caller or persisted. */
  conversationStore?: string
}

export async function assertAdoptedSourceIdentity(
  source: AdoptedTranscriptSource,
  actual: { sessionId: string | null; cwd: string | null },
  requireCwd = true,
  signal?: AbortSignal,
  agent?: AgentType
): Promise<void> {
  if (actual.sessionId !== source.providerSessionId) {
    throw new Error('The saved conversation does not match the requested provider identity.')
  }
  if (!requireCwd) {
    return
  }
  if (!actual.cwd) {
    throw new Error('This conversation belongs to another directory.')
  }
  // Create resolves a sub-folder conversation's source to that folder, so the import matches exactly.
  if (
    (await adoptedSourceFolder(source.workspaceCwd, actual.cwd, signal, agent)) !==
    source.workspaceCwd
  ) {
    throw otherFolderRefusal()
  }
}

function otherFolderRefusal() {
  return agentSessionRefusalError(
    'agent_session_identity_required',
    { reason: 'transcriptUnreadable', otherFolder: true },
    'This conversation belongs to another directory.'
  )
}

/** The folder a conversation recorded in `cwd` resumes in under this workspace: the workspace
 *  itself, the sub-folder it was saved in (Session History lists those under the workspace too),
 *  or null for another folder. */
async function adoptedSourceFolder(
  workspaceCwd: string,
  recordedCwd: string,
  signal?: AbortSignal,
  agent?: AgentType
): Promise<string | null> {
  const cwd = recordedCwd.trim()
  if (
    normalizeRuntimePathForComparison(cwd) ===
    normalizeRuntimePathForComparison(workspaceCwd.trim())
  ) {
    return workspaceCwd
  }
  // Agents record a resolved folder; a dot segment could name one outside the workspace.
  const nested = !cwd.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')
  // A sub-folder is spelled from the workspace path, the one every other path on this host uses.
  const inside = nested ? relativePathInsideRoot(workspaceCwd.trim(), cwd) : null
  if (inside) {
    return join(workspaceCwd, inside)
  }
  // Pi's launch compares real paths, so its adoption must agree with that compare.
  if (agent === 'pi' && (await samePiDirectory(cwd, workspaceCwd))) {
    return workspaceCwd
  }
  const relative = await adoptedDirectoryProbes.relate(workspaceCwd, cwd, signal)
  if (relative && nested) {
    return join(workspaceCwd, relative)
  }
  return relative === '' && agent !== 'pi' ? workspaceCwd : null
}

// Observe metadata from the same lines imported into the journal.
export function adoptedTranscriptSourceObserver(input: {
  agent: AgentType
  filePath: string
  source: AdoptedTranscriptSource
  maxSourceBytes: number
  signal?: AbortSignal
}) {
  let sessionId: string | null =
    input.agent === 'claude' || input.agent === 'codex'
      ? sessionIdFromFileName(input.filePath)
      : null
  let cwd: string | null = null
  let sawCodexMetadata = false
  /** The conversation's recorded identity, read after every line is observed. */
  const identity = async (): Promise<{ sessionId: string | null; cwd: string | null }> => {
    if (input.agent === 'grok') {
      const summaryPath = join(dirname(input.filePath), 'summary.json')
      if (!(await admitTranscriptPath(dirname(input.filePath), summaryPath))) {
        throw new Error('The conversation summary is outside its storage directory.')
      }
      const { buffer } = await readNodeFileWithinLimit(summaryPath, input.maxSourceBytes, {
        regularFileOnly: true
      })
      const summary = asRecord(asRecord(JSON.parse(buffer.toString('utf8')))?.info)
      sessionId = extractString(summary?.id) ?? sessionIdFromFileName(dirname(input.filePath))
      cwd = extractString(summary?.cwd)
    }
    if (input.agent === 'pi' && sessionIdFromFileName(input.filePath) !== sessionId) {
      throw new Error('The saved conversation header does not match its file identity.')
    }
    // Moved or copied chats keep their old cwd; Claude and Grok resume from the cwd's bucket regardless.
    if (isWorkspaceCwdBucket(input.agent, input.filePath, input.source.workspaceCwd)) {
      cwd = input.source.workspaceCwd
    }
    return { sessionId, cwd }
  }
  return {
    /** True once the line stream has given the conversation's folder. */
    observe(line: string): boolean {
      const record = parseJsonObject(line)
      if (!record) {
        return cwd !== null
      }
      if (input.agent === 'claude') {
        sessionId = extractString(record.sessionId) ?? sessionId
        cwd ??= extractString(record.cwd)
      } else if (input.agent === 'codex' && record.type === 'session_meta' && !sawCodexMetadata) {
        sawCodexMetadata = true
        const payload = asRecord(record.payload)
        sessionId = extractString(payload?.id) ?? sessionId
      } else if ((input.agent === 'omp' || input.agent === 'pi') && record.type === 'session') {
        sessionId = extractString(record.id)
        cwd = extractString(record.cwd)
      }
      return cwd !== null
    },
    identity,
    async validate() {
      await assertAdoptedSourceIdentity(
        input.source,
        await identity(),
        input.agent !== 'codex',
        input.signal,
        input.agent
      )
    }
  }
}

// Windows file systems resolve bucket names without case, as the agents' own lookups do.
function isWorkspaceCwdBucket(agent: AgentType, filePath: string, cwd: string): boolean {
  const fold = (name: string) => (process.platform === 'win32' ? name.toLowerCase() : name)
  if (agent === 'grok') {
    const encoded = grokEncodedCwdDirName(cwd)
    return encoded !== null && fold(basename(dirname(dirname(filePath)))) === fold(encoded)
  }
  return (
    agent === 'claude' &&
    encodeClaudeProjectPaths(cwd).some((encoded) =>
      isClaudeProjectOwnBucketName(fold(basename(dirname(filePath))), fold(encoded))
    )
  )
}

async function readAdoptedOpenCodeIdentity(
  dbPath: string,
  source: AdoptedTranscriptSource,
  signal?: AbortSignal
): Promise<{ sessionId: string | null; cwd: string | null }> {
  const metadata = await readOpenCodeTranscriptSignalViaWorker(
    { dbPath, sessionId: source.providerSessionId },
    signal
  )
  return { sessionId: metadata ? source.providerSessionId : null, cwd: metadata?.cwd ?? null }
}

export async function validateAdoptedOpenCodeSource(
  dbPath: string,
  source: AdoptedTranscriptSource,
  signal?: AbortSignal
): Promise<void> {
  await assertAdoptedSourceIdentity(
    source,
    await readAdoptedOpenCodeIdentity(dbPath, source, signal),
    true,
    signal
  )
}

// Agents record their folder in the opening records, so reading stops there; one record may hold
// a pasted image, so the bound matches the import's record limit.
const ADOPTED_FOLDER_HEAD_BYTES = 16 * 1024 * 1024
const ADOPTED_SUMMARY_BYTES = 1024 * 1024

function folderCheckedTranscriptAgent(agent: AgentType) {
  const transcriptAgent = agent === 'pi' ? 'omp' : resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent === 'codex' ? null : transcriptAgent
}

async function readAdoptedHermesIdentity(dbPath: string, source: AdoptedTranscriptSource) {
  const session = await parseHermesSqliteSessionViaWorker({
    dbPath,
    sessionId: source.providerSessionId,
    platform: process.platform
  })
  return { cwd: session?.cwd ?? null }
}

/** Whether create refuses a conversation saved in another folder. */
export function adoptionChecksFolder(agent: AgentType): boolean {
  return folderCheckedTranscriptAgent(agent) !== null
}

/** The folder an adopted conversation resumes in: the workspace, or the sub-folder it was saved in.
 *  Read from the transcript's opening records only; refuses another folder and leaves any other
 *  outcome, including which conversation the file holds, to the full import. Hermes moves a
 *  conversation into whatever folder loads it, so another folder resumes in the workspace. */
type AdoptedTranscriptFolderInput = {
  agent: AgentType
  filePath: string
  source: AdoptedTranscriptSource
  signal?: AbortSignal
}

export async function resolveAdoptedTranscriptFolder(
  input: AdoptedTranscriptFolderInput
): Promise<string> {
  const { source } = input
  const transcriptAgent = folderCheckedTranscriptAgent(input.agent)
  try {
    let actual: { cwd: string | null } | null = null
    if (input.agent === 'hermes') {
      actual = await readAdoptedHermesIdentity(input.filePath, source)
    } else if (transcriptAgent === 'opencode') {
      actual = await readAdoptedOpenCodeIdentity(input.filePath, source, input.signal)
    } else if (transcriptAgent) {
      actual = await readAdoptedTranscriptHeadIdentity(input)
    }
    if (!actual?.cwd) {
      return source.workspaceCwd
    }
    const folder = await adoptedSourceFolder(
      source.workspaceCwd,
      actual.cwd,
      input.signal,
      input.agent
    )
    if (folder === null && input.agent !== 'hermes') {
      throw otherFolderRefusal()
    }
    return folder ?? source.workspaceCwd
  } catch (error) {
    const refusal = isAgentSessionRefusalError(error) ? error.refusal : null
    if (refusal?.code === 'agent_session_identity_required' && refusal.details?.otherFolder) {
      throw error
    }
    return source.workspaceCwd
  }
}

async function readAdoptedTranscriptHeadIdentity(input: AdoptedTranscriptFolderInput) {
  const observer = adoptedTranscriptSourceObserver({
    ...input,
    maxSourceBytes: ADOPTED_SUMMARY_BYTES
  })
  // Grok records its folder in the conversation summary, not in the transcript.
  if (input.agent !== 'grok') {
    const found = new AbortController()
    try {
      await decodeTranscriptStream(
        createReadStream(input.filePath, {
          end: ADOPTED_FOLDER_HEAD_BYTES - 1,
          signal: input.signal ? AbortSignal.any([input.signal, found.signal]) : found.signal
        }),
        input.filePath,
        0,
        (line) => {
          if (observer.observe(line)) {
            found.abort()
          }
          return null
        },
        false
      )
    } catch (error) {
      if (!found.signal.aborted || input.signal?.aborted) {
        throw error
      }
    }
  }
  return observer.identity()
}
