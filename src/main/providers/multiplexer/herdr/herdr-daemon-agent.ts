export function detectAgentFromBuffer(buffer: string): string | null {
  if (buffer.includes('codex') || buffer.includes('CODEX_')) {
    return 'codex'
  }
  if (buffer.includes('claude') || buffer.includes('CLAUDE_')) {
    return 'claude'
  }
  if (buffer.includes('omp') || buffer.includes('OMP_')) {
    return 'omp'
  }
  if (buffer.includes('pi ') || buffer.includes('PI_')) {
    return 'pi'
  }
  if (buffer.includes('grok') || buffer.includes('GROK_')) {
    return 'grok'
  }
  return null
}

export type HerdrAgentManifest = {
  name: string
  kind: string
  command: string
  source: string
  version: string
}

// Why: the in-app daemon's built-in agent manifest registry. Stock herdr loads
// these from disk; the daemon serves the same surface from a static list so the
// client can list/start agents without an external manifest file.
export const HERDR_AGENT_MANIFESTS: HerdrAgentManifest[] = [
  { name: 'codex', kind: 'cli', command: 'codex', source: 'builtin', version: '1' },
  { name: 'claude', kind: 'cli', command: 'claude', source: 'builtin', version: '1' },
  { name: 'omp', kind: 'cli', command: 'omp', source: 'builtin', version: '1' },
  { name: 'pi', kind: 'cli', command: 'pi', source: 'builtin', version: '1' },
  { name: 'grok', kind: 'cli', command: 'grok', source: 'builtin', version: '1' }
]

export function findAgentManifest(name: string): HerdrAgentManifest | undefined {
  return HERDR_AGENT_MANIFESTS.find((manifest) => manifest.name === name)
}

export function getAgentEnv(agent: string): Record<string, string> {
  const base = {
    ORCA_AGENT: agent,
    ORCA_AGENT_SESSION: crypto.randomUUID()
  }

  switch (agent) {
    case 'codex':
      return {
        ...base,
        CODEX_SKIP_GIT_REPO_CHECK: '1',
        CODEX_SKIP_AUTO_UPDATES: '1'
      }
    case 'claude':
      return {
        ...base,
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1'
      }
    case 'omp':
      return {
        ...base,
        OMP_NO_BANNER: '1'
      }
    case 'pi':
      return {
        ...base,
        PI_QUIET: '1'
      }
    default:
      return base
  }
}
