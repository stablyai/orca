// src/relay/agent-session-capabilities.ts
// Dynamic capability detection for the agent handshake — split out of
// agent-session.ts to keep that file under oxlint's max-lines budget.
//
// checkGitAvailable/checkPtyAvailable/buildCapabilities (WT-Issue-2) probe
// what's actually installed and functional on this Dev Server;
// STATIC_CAPABILITIES_FALLBACK is the value buildCapabilities() would
// produce if both probes succeeded, used only when the live check times
// out or throws — see buildCapabilities()'s caller in
// agent-session-handshake.ts for the 5s-timeout race.

import type { AgentConfig } from './agent-config'
import type { AgentLogger } from './agent-logger'

/**
 * checkGitAvailable — Check if git binary is accessible in toolPath or system PATH.
 * Quick check via fs.access first, fallback to spawning git --version.
 */
export async function checkGitAvailable(config: AgentConfig): Promise<boolean> {
  const { access: fsAccess, constants } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dirs = (config.toolPath ?? process.env['PATH'] ?? '').split(':').filter(Boolean)
  for (const dir of dirs) {
    try {
      await fsAccess(join(dir, 'git'), constants.X_OK)
      return true
    } catch {
      /* continue to next dir */
    }
  }
  // Fallback: try running git --version (works on Windows too)
  const { execFile } = await import('node:child_process')
  return new Promise<boolean>((resolve) => {
    const child = execFile('git', ['--version'], { timeout: 3000 })
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

/**
 * checkPtyAvailable — Check if node-pty native module loads successfully.
 * Returns false if the native module is missing or incompatible.
 */
export async function checkPtyAvailable(): Promise<boolean> {
  try {
    await import('node-pty')
    return true
  } catch {
    return false
  }
}

/**
 * buildCapabilities — Dynamically build the capabilities list based on what is
 * actually installed and functional on this Dev Server.
 * Falls back to a static list if the check takes > 5 seconds.
 */
export async function buildCapabilities(
  config: AgentConfig,
  log: AgentLogger
): Promise<readonly string[]> {
  const caps: string[] = [
    'fs',
    'fs.watch',
    'preflight',
    'ai.providers',
    'agent.spawn',
    'agent.exec',
    'agent.sendInput',
    'agent.kill'
  ]

  const [hasGit, hasPty] = await Promise.all([checkGitAvailable(config), checkPtyAvailable()])

  log.info(`capability check: git=${hasGit} pty=${hasPty}`)

  if (hasGit) {
    caps.push('git', 'git.exec', 'git.execStream')
    caps.push('worktrees', 'git.worktree.list', 'git.worktree.add', 'git.worktree.remove')
  }
  if (hasPty) {
    caps.push(
      'pty',
      'pty.create',
      'pty.write',
      'pty.resize',
      'pty.destroy',
      'pty.scrollback',
      'pty.stream',
      'pty.attach'
    )
  }

  log.info(`capabilities: [${caps.join(', ')}]`)
  return caps
}

// Why: this fallback is used when buildCapabilities() times out (>5 s) or
// throws. It must mirror what buildCapabilities() pushes when both git and
// node-pty are available, otherwise the server-side ptyReady gate
// (dev-server-provider-lifecycle.ts: `caps.includes('pty') && caps.includes('pty.stream')`)
// will always fail and no PTY provider is ever registered for this connection
// — producing "No PTY provider registered for connection 'dev-01'" on every
// terminal.create call.
export const STATIC_CAPABILITIES_FALLBACK = [
  'fs',
  'fs.watch',
  'git',
  'preflight',
  'ai.providers',
  'agent.spawn',
  'worktrees',
  'git.exec',
  'git.execStream',
  'git.worktree.list',
  'git.worktree.add',
  'git.worktree.remove',
  'pty',
  'pty.create',
  'pty.write',
  'pty.resize',
  'pty.destroy',
  'pty.scrollback',
  'pty.stream',
  'pty.attach'
] as const
