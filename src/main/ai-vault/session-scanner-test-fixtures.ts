import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function isolatedScanRoots(root: string) {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    antigravityBrainDir: join(root, 'antigravity-brain'),
    copilotSessionsDir: join(root, 'copilot-sessions'),
    cursorProjectsDir: join(root, 'cursor-projects'),
    opencodeStorageDir: join(root, 'opencode-storage'),
    // Why: prevent the SQLite scanner from picking up the real
    // ~/.local/share/opencode/opencode.db during tests.
    opencodeDbPaths: [] as readonly string[],
    grokSessionsDir: join(root, 'grok-sessions'),
    devinTranscriptsDir: join(root, 'devin-transcripts'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    ompSessionsDir: join(root, 'omp-sessions'),
    primeAgentSessionsDir: join(root, 'prime-agent-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects'),
    clineSessionsDir: join(root, 'cline-sessions'),
    kimiSessionsDir: join(root, 'kimi-sessions')
  }
}

export function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

export async function writeJsonlFile(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, jsonLines(records))
}

export async function writeAntigravityTranscript(
  brainDir: string,
  sessionId: string,
  records: unknown[]
): Promise<string> {
  const transcriptPath = join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl')
  await writeJsonlFile(transcriptPath, records)
  return transcriptPath
}

export function writeAntigravityHistory(brainDir: string, records: unknown[]): Promise<void> {
  return writeJsonlFile(join(dirname(brainDir), 'history.jsonl'), records)
}

// Message-graph fixtures for the Pi forks: each writes one session transcript
// and returns its path, since both agents resume by absolute transcript path.
export async function writeOmpScannerFixture(sessionsDir: string): Promise<string> {
  const sessionFile = join(sessionsDir, 'omp-session.jsonl')
  await writeJsonlFile(sessionFile, [
    {
      type: 'session',
      version: 3,
      id: 'omp-session',
      title: 'OMP session title',
      timestamp: '2026-05-01T10:08:30.000Z',
      cwd: '/tmp/omp'
    },
    {
      type: 'model_change',
      model: 'gpt-5.4-mini',
      timestamp: '2026-05-01T10:08:30.500Z'
    },
    {
      type: 'message',
      timestamp: '2026-05-01T10:08:31.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'OMP title' }] }
    },
    {
      type: 'message',
      timestamp: '2026-05-01T10:08:32.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'OMP answer' }],
        model: 'gpt-5.4-mini',
        // totalTokens deliberately != input+output so the assertion proves
        // the explicit-total field is read, not an input/output sum.
        usage: { input: 10, output: 5, totalTokens: 160 }
      }
    }
  ])
  return sessionFile
}

// Prime Agent shares Pi's message-graph format (and its `modelId` key) but
// reads its own ~/.prime/agent/sessions root.
export async function writePrimeAgentScannerFixture(sessionsDir: string): Promise<string> {
  const sessionFile = join(sessionsDir, 'prime-agent-session.jsonl')
  await writeJsonlFile(sessionFile, [
    {
      type: 'session',
      version: 3,
      id: 'prime-agent-session',
      timestamp: '2026-05-01T10:08:40.000Z',
      cwd: '/tmp/prime-agent'
    },
    {
      type: 'model_change',
      provider: 'prime-intellect',
      modelId: 'inference/big-model',
      timestamp: '2026-05-01T10:08:40.500Z'
    },
    {
      type: 'message',
      timestamp: '2026-05-01T10:08:41.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Prime Agent title' }] }
    }
  ])
  return sessionFile
}

export function writeAntigravityScannerFixture(
  brainDir: string,
  sessionId: string
): Promise<string> {
  return writeAntigravityTranscript(brainDir, sessionId, [
    {
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-05-01T10:02:30.000Z',
      content: '<USER_REQUEST>Antigravity title</USER_REQUEST>'
    },
    {
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-05-01T10:02:31.000Z',
      content: 'Done'
    }
  ])
}
