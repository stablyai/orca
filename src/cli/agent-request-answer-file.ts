import { readFile, stat } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import { RuntimeClientError } from './runtime/types'
import { AgentRequestMarkerSchema } from './agent-request-inventory'
import {
  RespondParams,
  RespondToQuestionParams
} from '../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from '../shared/structured-agent-session-mutation'

const AnswerFile = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    expectedRuntimeId: z.string().min(1),
    expectedRequests: AgentRequestMarkerSchema,
    itemId: z.string().min(1),
    kind: z.enum(['approval', 'question']),
    expectedRuntimeFence: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    clientOperationId: z.string().uuid(),
    turnItemId: z.string().min(1).optional(),
    optionId: z.string().optional(),
    answers: z.unknown().optional()
  })
  .strict()
export type AgentRequestAnswerFile = z.infer<typeof AnswerFile>

/** Loads size-checked JSON using strict UTF-8, allowing one leading BOM and rejecting invalid bytes. */
export async function readAgentRequestAnswerFile(path: string): Promise<AgentRequestAnswerFile> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 128 * 1024) {
      throw new Error('size')
    }
    const bytes = await readFile(path)
    if (bytes.byteLength > 128 * 1024) {
      throw new Error('size')
    }
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return parseAgentRequestAnswerFile(JSON.parse(content.replace(/^\uFEFF/, '')))
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      'The request file is not a valid bounded native answer JSON file.'
    )
  }
}

/** Validates identity fields, matching session IDs and the native answer schema before submission. */
export function parseAgentRequestAnswerFile(value: unknown): AgentRequestAnswerFile {
  const parsed = AnswerFile.safeParse(value)
  if (!parsed.success || parsed.data.expectedRequests.sessionId !== parsed.data.sessionId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The request file has an invalid native request identity.'
    )
  }
  // The existing host schema preserves question ids, selected ids and UTF-8 typed answers verbatim.
  nativeAnswerParams(parsed.data)
  return parsed.data
}

/** Fingerprints native answer fields while preserving question IDs, choices and typed text. */
export function nativeAnswerParams(input: AgentRequestAnswerFile) {
  const envelope = {
    sessionId: input.sessionId,
    clientOperationId: input.clientOperationId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    payloadFingerprint: '0'.repeat(64)
  }
  const fields = {
    itemId: input.itemId,
    expectedRevision: input.expectedRevision,
    ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
    ...(input.answers === undefined ? {} : { answers: input.answers })
  }
  const parsed =
    input.kind === 'approval'
      ? RespondParams.safeParse({ envelope, ...fields })
      : RespondToQuestionParams.safeParse({ envelope, ...fields })
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The answer does not match the native approval/question schema.'
    )
  }
  const { envelope: _envelope, ...answerFields } = parsed.data
  return {
    ...answerFields,
    envelope: {
      ...envelope,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: `agentSession.respondTo:${input.kind}`,
        sessionId: input.sessionId,
        fields: answerFields
      })
    }
  }
}
