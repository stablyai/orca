import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Options } from '@vitejs/plugin-react'

// Render reads the compiler would freeze; keeping them live needs an extra render or a behavior change.
const UNCOMPILED_FILES = [
  // Render-time reads of providerRuntimeSessionGeneration (lib/provider-runtime-context.ts).
  'src/renderer/src/components/feature-wall/FeatureWallSetupChecklist.tsx',
  'src/renderer/src/components/feature-wall/use-integration-connection-status.ts',
  'src/renderer/src/components/integrations/task-trackers/jira-integration-card.tsx',
  'src/renderer/src/components/integrations/task-trackers/linear-integration-card.tsx',
  'src/renderer/src/components/new-workspace/use-jira-source-connection.ts',
  'src/renderer/src/components/new-workspace/use-work-item-source-foundation.ts',
  'src/renderer/src/components/settings/skills/linear/LinearAgentSkillPane.tsx',
  'src/renderer/src/components/settings/tasks/use-task-source-provider-readiness.ts',
  'src/renderer/src/components/sidebar/workspace-card/details/use-worktree-card-review-details.ts',
  'src/renderer/src/components/task-page/jira/Content.tsx',
  'src/renderer/src/components/task-page/jira/use-task-page-jira-list-projection.ts',
  'src/renderer/src/components/task-page/jira/use-task-page-jira-list-state.ts',
  'src/renderer/src/hooks/use-integration-provider-status-refresh.ts',
  // structuredSessionSelectionAuthority/Controller read module state the selection lifetime replaces.
  'src/renderer/src/components/native-chat/session/options/structured/use-structured-agent-session-option-state.ts',
  // applyTerminalColdActivation mutates controller refs during render on the terminal hot path.
  'src/renderer/src/components/use-terminal-controller.ts'
]

// Files still listed in these ratchets would run differently once compiled.
const HAZARD_BASELINES = [
  'config/render-path-translate-baseline.txt',
  'config/react-compiler-hazard-baseline.txt'
]

function baselineFiles(baseline: string): string[] {
  return readFileSync(resolve(baseline), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^\d+\s+/, '').split('#')[0])
}

export function reactCompilerExcludedFiles(): string[] {
  return [...new Set([...UNCOMPILED_FILES, ...HAZARD_BASELINES.flatMap(baselineFiles)])]
}

export function isReactCompilerEnabled(): boolean {
  return process.env.ORCA_REACT_COMPILER !== '0'
}

export const REACT_COMPILER_OPTIONS = { target: '19' } as const

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function reactCompilerExcludePattern(): RegExp {
  return new RegExp(`/(?:${reactCompilerExcludedFiles().map(escapeRegExp).join('|')})$`)
}

// ORCA_REACT_COMPILER=0 builds without the compiler for bisecting.
export function reactPluginOptions(): Options {
  if (!isReactCompilerEnabled()) {
    return {}
  }
  return {
    compiler: REACT_COMPILER_OPTIONS,
    exclude: [/\/node_modules\//, reactCompilerExcludePattern()]
  }
}
