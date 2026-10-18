import { describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_RUNTIME_METADATA,
  structuredAgentRuntimeMetadata
} from './structured-agent-runtime-metadata'

vi.mock('./structured-agent-runtime-registrations', () => {
  throw new Error('Metadata reads must not load adapter factories')
})
vi.mock('../codex/codex-structured-session-adapter', () => {
  throw new Error('Metadata reads must not load the Codex adapter')
})
vi.mock('./structured-claude-runtime-adapter', () => {
  throw new Error('Metadata reads must not load the Claude adapter')
})
vi.mock('../acp/acp-structured-session-adapter', () => {
  throw new Error('Metadata reads must not load the ACP adapter')
})
vi.mock('../pi/rpc-session-adapter', () => {
  throw new Error('Metadata reads must not load the Pi adapter')
})

describe('structured agent metadata without adapter implementations', () => {
  it('lists the registered agents before any host or factory is loaded', () => {
    expect(STRUCTURED_AGENT_RUNTIME_METADATA.map(({ definition }) => definition.agent)).toEqual([
      'pi',
      'codex',
      'claude',
      'grok',
      'opencode',
      'opencode2',
      'omp',
      'antigravity'
    ])
    expect(
      STRUCTURED_AGENT_RUNTIME_METADATA.every((metadata) => !('createAdapter' in metadata))
    ).toBe(true)
    expect(structuredAgentRuntimeMetadata('cursor')).toBeNull()
  })
})
