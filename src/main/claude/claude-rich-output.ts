import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { restoreOrStripOverlayEnv } from '../../shared/agent-overlay-env'
import type { BuildPtyHostEnvOptions } from '../ipc/pty/host-env/types'
import { findClaudeRichOutputConflicts } from './claude-rich-output-conflicts'

type ClaudeRichOutputLaunch = Pick<
  BuildPtyHostEnvOptions,
  'isPackaged' | 'resourcesPath' | 'launchAgent' | 'isWsl'
> & { cwd?: string }

const overlay = {
  primary: 'CLAUDE_CODE_PLUGIN_DIRS',
  overlay: 'ORCA_CLAUDE_PLUGIN_DIRS',
  source: 'ORCA_CLAUDE_SOURCE_PLUGIN_DIRS',
  preserveExplicitPrimary: true
}

function bundledRoots(options: ClaudeRichOutputLaunch): string[] {
  const roots = options.resourcesPath ? [join(options.resourcesPath, 'claude-rich-output')] : []
  if (hasAppEnvironment()) {
    const appPath = getAppEnvironment().getAppPath()
    roots.push(
      join(appPath, options.isPackaged ? 'claude-rich-output' : 'resources/claude-rich-output')
    )
  }
  return roots
}

export async function applyClaudeRichOutputEnv(
  env: Record<string, string>,
  options: ClaudeRichOutputLaunch,
  roots: readonly string[] = bundledRoots(options),
  inheritedEnv: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const enabled = env.ORCA_CLAUDE_RICH_OUTPUT === '1'
  // The launch intent must not leak into a nested Orca process after this host consumes it.
  delete env.ORCA_CLAUDE_RICH_OUTPUT
  restoreOrStripOverlayEnv(env, overlay, inheritedEnv)
  if (options.launchAgent !== 'claude' || !enabled || options.isWsl || !options.cwd) {
    return
  }
  const launchEnv = { ...env }
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS']) {
    const value = inheritedEnv[key]
    if (launchEnv[key] === undefined && value !== undefined) {
      launchEnv[key] = value
    }
  }
  restoreOrStripOverlayEnv(launchEnv, overlay, inheritedEnv)
  const root = roots.find((candidate) =>
    ['reply-markdown', 'reply-media'].every((name) =>
      existsSync(join(candidate, name, '.claude-plugin', 'plugin.json'))
    )
  )
  if (!root) {
    console.warn('[claude-rich-output] Bundled modules unavailable on this execution host')
    return
  }
  const source = launchEnv.CLAUDE_CODE_PLUGIN_DIRS ?? ''
  const dirs = new Set(source.split(delimiter).filter(Boolean))
  let installed: Set<string>
  try {
    installed = await findClaudeRichOutputConflicts(launchEnv, options.cwd)
  } catch (error) {
    console.warn(
      '[claude-rich-output] Could not inspect existing plugins; keeping the ordinary launch:',
      error instanceof Error ? error.message : String(error)
    )
    return
  }
  const originalSize = dirs.size
  for (const name of ['reply-markdown', 'reply-media']) {
    if (!installed.has(name)) {
      dirs.add(join(root, name))
    }
  }
  if (dirs.size === originalSize) {
    return
  }
  env.CLAUDE_CODE_PLUGIN_DIRS = [...dirs].join(delimiter)
  env.ORCA_CLAUDE_PLUGIN_DIRS = env.CLAUDE_CODE_PLUGIN_DIRS
  if (source) {
    env.ORCA_CLAUDE_SOURCE_PLUGIN_DIRS = source
  }
}
