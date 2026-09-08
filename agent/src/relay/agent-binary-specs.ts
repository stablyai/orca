/**
 * agent-binary-specs.ts — per-model AgentBinarySpec table and CLI-arg
 * resolution for agent-spawner.ts (CR-AG-12).
 *
 * Split out of agent-spawner.ts (oxlint max-lines) — see that file's header
 * for the full picture of how these pieces fit together.
 *
 * ORCH-012: Removed invalid --no-cache flag from claude args.
 * ORCH-004: Added codex (gpt-* prefix), opencode, and ollama (local inference).
 * Uses prefix-matching so claude-opus-4, gpt-4o, gemini-2.0 all resolve correctly.
 *
 * @module relay/agent-binary-specs
 */
import { YOLO_TUI_AGENT_ARGS } from '../shared/tui-agent-permissions'
import type { AgentBinarySpec, AgentSpawnRequest } from './agent-spawn-types'

const AGENT_SPECS: AgentBinarySpec[] = [
  // index 0: claude — output-format stream-json for automation; --verbose for tracing
  {
    binary: 'claude',
    buildArgs: (req) => {
      const args = req?.resumeId
        ? ['--resume', req.resumeId]
        : ['--output-format', 'stream-json', '--verbose']
      // BUG-AG-HLD-008: flag verified trong YOLO_TUI_AGENT_ARGS (dùng thật cho TUI launcher)
      if (req?.trustPreset === 'full') {
        args.push(YOLO_TUI_AGENT_ARGS.claude!)
      }
      return args
    },
    apiKeyEnvVar: 'ANTHROPIC_API_KEY'
  },
  // index 1: codex / openai compatible
  {
    binary: 'codex',
    buildArgs: (req) => {
      const args = req?.resumeId ? ['--session-file', `~/.codex/${req.resumeId}.json`] : []
      if (req?.trustPreset === 'full') {
        args.push(YOLO_TUI_AGENT_ARGS.codex!)
      }
      return args
    },
    apiKeyEnvVar: 'OPENAI_API_KEY'
  },
  // index 2: gemini — BUG-AG-HLD-007: resumeId giờ map sang `--resume <id>`,
  // cú pháp giống claude, verified qua getAgentResumeArgv() trong
  // ../shared/agent-session-resume.ts:206 (dùng thật cho sleeping-agent resume).
  // ⚠️ CHƯA smoke-test với binary gemini thật qua agent.spawn headless PTY —
  // xem "Phương Án Dự Phòng" trong TASK-AG-HLD-012 nếu hành vi runtime sai khác.
  {
    binary: 'gemini',
    buildArgs: (req) => {
      const args = req?.resumeId ? ['--resume', req.resumeId] : ['--stream']
      if (req?.trustPreset === 'full') {
        args.push(YOLO_TUI_AGENT_ARGS.gemini!)
      }
      return args
    },
    apiKeyEnvVar: 'GEMINI_API_KEY'
  },
  // index 3: opencode — no API key needed (uses its own auth).
  // BUG-AG-HLD-007: resumeId map sang `--session <id>` — KHÔNG PHẢI `resume <id>`
  // như BL-AG-03 mô tả trước đây. Verified qua getAgentResumeArgv() trong
  // ../shared/agent-session-resume.ts:210.
  // ⚠️ CHƯA smoke-test với binary opencode thật qua agent.spawn headless PTY —
  // xem "Phương Án Dự Phòng" trong TASK-AG-HLD-012 nếu hành vi runtime sai khác.
  // Flag trustPreset của opencode ('--dangerously-skip-permissions', nguồn
  // tui-agent-launch-defaults.ts) có độ tin cậy THẤP HƠN claude/codex/gemini —
  // chưa verify hoạt động "theo preset" trong agent.spawn headless PTY, chỉ
  // biết CLI chấp nhận flag ở launcher khác. Xem "Phương Án Dự Phòng" TASK-AG-HLD-014.
  {
    binary: 'opencode',
    buildArgs: (req) => {
      const args = req?.resumeId ? ['--session', req.resumeId] : []
      if (req?.trustPreset === 'full') {
        args.push('--dangerously-skip-permissions')
      }
      return args
    },
    apiKeyEnvVar: null
  },
  // index 4: ollama — local inference, no external API key
  { binary: 'ollama', buildArgs: () => [], apiKeyEnvVar: null, localInference: true }
]

const MODEL_PREFIX_MAP: [prefix: string, specIndex: number][] = [
  ['claude', 0],
  ['gpt-', 1],
  ['codex', 1],
  ['gemini', 2],
  ['opencode', 3],
  ['ollama', 4] // matches 'ollama' and 'ollama-*'
]

export function resolveAgentSpec(modelId: string): AgentBinarySpec | undefined {
  if (!modelId) {
    return undefined
  }
  for (const [prefix, idx] of MODEL_PREFIX_MAP) {
    if (modelId === prefix || modelId.startsWith(`${prefix}-`) || modelId.startsWith(prefix)) {
      return AGENT_SPECS[idx]
    }
  }
  return undefined
}

// ── buildAgentArgs helper ──────────────────────────────────────────────────────

export function buildAgentArgs(spec: AgentBinarySpec, req: AgentSpawnRequest): string[] {
  return spec.buildArgs({ resumeId: req.resumeId, trustPreset: req.trustPreset })
}
