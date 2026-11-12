import { createHash } from 'node:crypto'
import { z } from 'zod'
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'
import { agentSessionAdvisoryPolicySchema } from '../../../shared/agent-session/agent-session-advisory-policy'
import type { AgentSessionAdvisoryReporter } from '../../../shared/agent-session/agent-session-advisory-report'
import { createClaudeAdvisoryReportTool } from './claude-advisory-report'

const jsonResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }]
})
const errorResult = (text: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text }]
})

/** Only verified text enters this server; artifact names never become filesystem paths. */
export function createClaudeAdvisoryArtifactServer(
  input: unknown,
  sdk: Pick<typeof ClaudeSdk, 'createSdkMcpServer' | 'tool'>,
  signal: AbortSignal,
  publish?: AgentSessionAdvisoryReporter
) {
  const parsed = agentSessionAdvisoryPolicySchema.safeParse(input)
  if (!parsed.success) {
    throw new Error('Invalid advisory artifact snapshot.')
  }
  const artifacts = new Map<string, { sha256: string; text: string }>()
  let size = 0
  for (const artifact of parsed.data.artifacts) {
    const bytes = Buffer.from(artifact.text, 'utf8')
    size += bytes.length
    if (
      size > 1_048_576 ||
      bytes.toString('utf8') !== artifact.text ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    ) {
      throw new Error('Invalid advisory artifact snapshot.')
    }
    artifacts.set(artifact.path, { sha256: artifact.sha256, text: artifact.text })
  }
  const isEnded = () => signal.aborted || Date.now() >= parsed.data.deadlineAt
  const ended = () => (isEnded() ? errorResult('Advisor artifact access ended.') : null)
  return sdk.createSdkMcpServer({
    name: 'orca_advisor',
    version: '1.0.0',
    timeout: 1_000,
    tools: [
      ...(publish ? [createClaudeAdvisoryReportTool(sdk, isEnded, publish)] : []),
      sdk.tool(
        'read_artifact',
        'Read admitted snapshot text. Offsets count UTF-16 code units.',
        {
          path: z.string().min(1).max(512),
          offset: z.number().int().min(0).max(1_048_576).optional(),
          limit: z.number().int().min(1).max(16_384).optional()
        },
        async ({ path, offset = 0, limit = 16_384 }) => {
          const refused = ended()
          if (refused) {
            return refused
          }
          const artifact = artifacts.get(path)
          if (!artifact) {
            return errorResult('Artifact unavailable.')
          }
          const text = artifact.text.slice(offset, offset + limit)
          return jsonResult({
            path,
            sha256: artifact.sha256,
            offset,
            nextOffset: offset + text.length,
            text
          })
        },
        { annotations: { readOnlyHint: true, openWorldHint: false } }
      ),
      sdk.tool(
        'search_artifacts',
        'Find literal text in admitted snapshots, returning at most 32 matches.',
        {
          query: z.string().min(1).max(256)
        },
        async ({ query }) => {
          const refused = ended()
          if (refused) {
            return refused
          }
          const matches: { path: string; offset: number; text: string }[] = []
          for (const [path, artifact] of artifacts) {
            let offset = artifact.text.indexOf(query)
            while (offset !== -1) {
              if (matches.length === 32) {
                return jsonResult({ matches, truncated: true })
              }
              matches.push({
                path,
                offset,
                text: artifact.text.slice(Math.max(0, offset - 80), offset + query.length + 80)
              })
              offset = artifact.text.indexOf(query, offset + 1)
            }
          }
          return jsonResult({ matches, truncated: false })
        },
        { annotations: { readOnlyHint: true, openWorldHint: false } }
      )
    ]
  })
}
