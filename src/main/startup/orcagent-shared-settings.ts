import { app } from 'electron'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Checks if the current process is running as Oagent or Orcagent.
 */
export function isOrcagentProcess(): boolean {
  const execPath = process.execPath || ''
  const envProduct = (process.env.ORCA_PRODUCT_NAME || '').toLowerCase()
  const name = typeof app?.getName === 'function' ? app.getName().toLowerCase() : ''
  return (
    execPath.includes('Oagent') ||
    execPath.includes('Orcagent') ||
    envProduct === 'oagent' ||
    envProduct === 'orcagent' ||
    name === 'oagent' ||
    name === 'orcagent'
  )
}

export const isOagentProcess = isOrcagentProcess

/**
 * Safely creates a symlink from src to dst for directory sharing.
 * If dst is an existing empty directory or broken symlink, it replaces it.
 */
function linkDirectoryIfPossible(src: string, dst: string): void {
  if (!existsSync(src)) {
    return
  }
  if (existsSync(dst)) {
    try {
      const stat = lstatSync(dst)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(dst)
        if (target === src) {
          return
        }
        unlinkSync(dst)
      } else {
        const entries = readdirSync(dst)
        if (entries.length === 0) {
          rmdirSync(dst)
        } else {
          return
        }
      }
    } catch {
      return
    }
  }
  try {
    mkdirSync(dirname(dst), { recursive: true })
    symlinkSync(src, dst, 'junction')
  } catch (err) {
    console.warn(`[oagent] Failed to link directory ${src} -> ${dst}:`, err)
  }
}

/**
 * Safely creates a symlink from src to dst for file sharing.
 */
function linkFileIfPossible(src: string, dst: string): void {
  if (!existsSync(src)) {
    return
  }
  if (existsSync(dst)) {
    try {
      const stat = lstatSync(dst)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(dst)
        if (target === src) {
          return
        }
        unlinkSync(dst)
      } else {
        return
      }
    } catch {
      return
    }
  }
  try {
    mkdirSync(dirname(dst), { recursive: true })
    symlinkSync(src, dst, 'file')
  } catch (err) {
    console.warn(`[oagent] Failed to link file ${src} -> ${dst}:`, err)
  }
}

/**
 * Ensures Oagent/Orcagent inherits user accounts, profiles, and settings,
 * while sharing skills, memories, and AI-vault directly with the primary Orca installation.
 */
export function seedOrcagentUserDataIfMissing(userDataPath: string, appName = 'Oagent'): void {
  const appData = app.getPath('appData')
  const orcaDir = join(appData, 'orca')
  if (!existsSync(orcaDir)) {
    return
  }

  try {
    mkdirSync(userDataPath, { recursive: true })

    // 1. Direct real-time symlinks for shared AI vault, speech models, and plugins
    const symlinkDirs = ['ai-vault', 'speech-models', 'plugins', 'plugins-data']
    for (const dir of symlinkDirs) {
      const src = join(orcaDir, dir)
      const dst = join(userDataPath, dir)
      linkDirectoryIfPossible(src, dst)
    }

    // 2. Shared Codex runtime home skills and memories
    const orcaCodexRuntime = join(orcaDir, 'codex-runtime-home')
    const targetCodexRuntime = join(userDataPath, 'codex-runtime-home')
    const orcaCodexHome = join(orcaCodexRuntime, 'home')
    const targetCodexHome = join(targetCodexRuntime, 'home')

    if (existsSync(orcaCodexHome)) {
      mkdirSync(targetCodexHome, { recursive: true })

      // Live 2-way shared skills and memories
      linkDirectoryIfPossible(join(orcaCodexHome, 'skills'), join(targetCodexHome, 'skills'))
      linkDirectoryIfPossible(join(orcaCodexHome, 'sessions'), join(targetCodexHome, 'sessions'))
      linkFileIfPossible(join(orcaCodexHome, 'memories_1.sqlite'), join(targetCodexHome, 'memories_1.sqlite'))

      // Inherit user-level prompts, hooks, and AGENTS.md links
      for (const item of ['prompts', 'hooks', 'AGENTS.md']) {
        const src = join(orcaCodexHome, item)
        const dst = join(targetCodexHome, item)
        if (existsSync(src) && !existsSync(dst)) {
          try {
            const stat = lstatSync(src)
            if (stat.isSymbolicLink()) {
              symlinkSync(readlinkSync(src), dst)
            } else {
              linkFileIfPossible(src, dst)
            }
          } catch {
            // Non-fatal
          }
        }
      }

      // Initial copy of auth and config files if missing
      for (const cfg of ['auth.json', 'config.toml']) {
        const src = join(orcaCodexHome, cfg)
        const dst = join(targetCodexHome, cfg)
        if (existsSync(src) && !existsSync(dst)) {
          try {
            cpSync(src, dst, { recursive: true, errorOnExist: false })
          } catch {
            // Non-fatal
          }
        }
      }

      for (const cfg of ['system-default-auth.json', 'shared-runtime-auth-provenance.json']) {
        const src = join(orcaCodexRuntime, cfg)
        const dst = join(targetCodexRuntime, cfg)
        if (existsSync(src) && !existsSync(dst)) {
          try {
            cpSync(src, dst, { recursive: true, errorOnExist: false })
          } catch {
            // Non-fatal
          }
        }
      }
    }

    // 3. Seed user accounts, profiles, and initial app configurations
    const itemsToCopy = [
      'orca-profile-index.json',
      'profiles',
      'codex-pane-accounts.json',
      'codex-accounts',
      'claude-accounts',
      'agent-hooks',
      'http1-compatibility.json',
      'macos-press-and-hold-default.json',
      'orca-e2ee-keypair.json'
    ]

    for (const item of itemsToCopy) {
      const src = join(orcaDir, item)
      const dst = join(userDataPath, item)
      if (existsSync(src) && !existsSync(dst)) {
        cpSync(src, dst, { recursive: true, errorOnExist: false })
      }
    }

    const marker = join(userDataPath, '.seeded-from-orca')
    if (!existsSync(marker)) {
      writeFileSync(marker, Date.now().toString(), 'utf8')
    }
  } catch (err) {
    console.warn(`[${appName.toLowerCase()}] Failed to configure shared settings from Orca:`, err)
  }
}

export const ORCA_BRIDGE_SKILL_CONTENT = `---
name: orca-bridge
description: >-
  Cross-terminal control and multi-agent communication in Orca, Oagent, and Orcagent. Use this skill whenever
  the user or an agent mentions terminal numbers like #1, #2, @1, @2, inter-terminal communication,
  commanding other terminals, reading other terminal outputs, or cross-terminal collaboration.
metadata:
  { "openclaw": { "emoji": "🌉", "os": ["darwin", "linux", "win32"] } }
---

# Orca Terminal Bridge

Cross-terminal control, messaging, and multi-agent coordination in Orca, Oagent, and Orcagent.

## Addressing Convention

- **Terminal Tab Badge (#1, #2, #3...)**: Each terminal in the active workspace has an assigned index displayed on its tab bar.
- **Target Addressing (@1, @2, @3... or @<title>)**: Use @<index> or @<label> to reference a specific terminal.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:
- If \`ORCA_CLI_COMMAND\` is set, use its value.
- In a dev checkout whose session exposes \`ORCA_DEV_REPO_ROOT\`, use \`orca-dev\`.
- On Linux outside an Orca-managed terminal, use \`orca-ide\`. Never run bare \`orca\` there (it resolves to GNOME screen reader).
- On macOS, use \`/Applications/Oagent.app/Contents/Resources/bin/orca\`, \`/Applications/Orcagent.app/Contents/Resources/bin/orca\`, or \`orca\`.
- Otherwise, use \`orca\`.

Below, \`ORCA\` represents the resolved executable.

## Command Reference

| Action | Command | Description |
|---|---|---|
| **List Terminals** | \`ORCA bridge list\` | View all active terminals in the workspace with targets (@1, @2), indexes, status, titles, and handles. |
| **Inspect Target** | \`ORCA bridge id\` | Print the current terminal's own @target ID. |
| **Read Output** | \`ORCA bridge read @2 50\` | Read the last N lines (default 50) of output from @2 and arms the read guard. |
| **Send Command** | \`ORCA bridge send @2 "npm test"\` | Type a command into @2 and press Enter to execute. |
| **Type Text** | \`ORCA bridge type @2 "git status"\` | Type text into @2 without pressing Enter. |
| **Send Message** | \`ORCA bridge message @2 "Build finished"\` | Send a formatted message with sender header to @2. |
| **Send Keys** | \`ORCA bridge keys @2 Enter\` | Send special keys (Enter, Escape, C-c) to @2. |
| **Rename / Label** | \`ORCA bridge name @2 "worker"\` | Assign a custom label to @2 so it can also be addressed as @worker. |

## Read Guard Pattern (Safety Floor)

To prevent race conditions between concurrent agents or interrupting active commands:
1. Always \`ORCA bridge read <target>\` to inspect current terminal state before typing.
2. If \`ORCA bridge send\` or \`type\` is called before reading, it is rejected by default to avoid corrupting active input (bypass with \`--no-read-guard\` or \`--force\` only when intentional).
3. After sending a long-running command, read back with \`ORCA bridge read <target>\` to verify the output.
`

export function getBridgeInstructions(appName = 'Oagent'): string {
  return `## ${appName} Terminal Bridge & @target Addressing

- Terminals in this ${appName} workspace are numbered \`#1\`, \`#2\`, \`#3\`... shown on tab badges.
- When the user or an instruction refers to \`@1\`, \`@2\`, \`@<name>\`, it addresses that specific terminal.
- Use \`orca bridge list\` to see all active terminals and their \`@targets\`.
- Use \`orca bridge read @<target> 50\` to inspect output.
- Use \`orca bridge send @<target> "<command>"\` to execute commands in the target terminal.
- Use \`orca bridge message @<target> "<text>"\` to communicate with another agent in that terminal.
`
}

export const ORCA_BRIDGE_INSTRUCTIONS = getBridgeInstructions('Oagent')

/**
 * Ensures that all AI agents started by Oagent/Orcagent immediately have access to the
 * orca-bridge skill and @target instructions in their runtime environment.
 *
 * Preserves existing customized skills in user directories (~/.agents, ~/.codex, ~/.claude)
 * and only updates the managed codex-runtime-home copy unconditionally.
 */
export function ensureOrcagentTerminalBridgeSkill(userDataPath: string, appName = 'Oagent'): void {
  try {
    // 1. Managed runtime home: maintain the official bridge skill
    const managedSkillDir = join(
      userDataPath,
      'codex-runtime-home',
      'home',
      'skills',
      'orca-bridge'
    )
    mkdirSync(managedSkillDir, { recursive: true })
    writeFileSync(join(managedSkillDir, 'SKILL.md'), ORCA_BRIDGE_SKILL_CONTENT, 'utf8')

    // 2. User directories: only seed if the skill does not already exist, preserving user modifications
    const home = homedir()
    if (home) {
      const userSkillDirs = [
        join(home, '.agents', 'skills', 'orca-bridge'),
        join(home, '.codex', 'skills', 'orca-bridge'),
        join(home, '.claude', 'skills', 'orca-bridge')
      ]

      for (const targetDir of userSkillDirs) {
        try {
          const skillFile = join(targetDir, 'SKILL.md')
          if (!existsSync(skillFile)) {
            mkdirSync(targetDir, { recursive: true })
            writeFileSync(skillFile, ORCA_BRIDGE_SKILL_CONTENT, 'utf8')
          }
        } catch {
          // Skip unwriteable system paths
        }
      }
    }

    // 3. Managed AGENTS.md: append instructions if not present
    const managedAgentsMd = join(userDataPath, 'codex-runtime-home', 'home', 'AGENTS.md')
    if (existsSync(managedAgentsMd)) {
      try {
        const content = readFileSync(managedAgentsMd, 'utf8')
        if (!content.includes('Terminal Bridge')) {
          const appended = `${content.trimEnd()}\n\n${getBridgeInstructions(appName)}\n`
          writeFileSync(managedAgentsMd, appended, 'utf8')
        }
      } catch {
        // Non-fatal
      }
    }
  } catch (err) {
    console.warn(`[${appName.toLowerCase()}] Failed to ensure terminal bridge skill:`, err)
  }
}

/**
 * Configures Oagent's / Orcagent's dedicated userData directory so it does not collide
 * with a concurrently running Orca instance, while sharing skills and memory.
 *
 * @returns True if the process was configured as Oagent/Orcagent; false otherwise.
 */
export function configureOrcagentUserData(): boolean {
  if (!isOrcagentProcess()) {
    return false
  }

  const execPath = process.execPath || ''
  const envProduct = (process.env.ORCA_PRODUCT_NAME || '').toLowerCase()
  const currentName = app.getName().toLowerCase()

  const isExplicitOrcagent =
    execPath.includes('Orcagent') ||
    envProduct === 'orcagent' ||
    currentName === 'orcagent'

  const appName = isExplicitOrcagent ? 'Orcagent' : 'Oagent'
  const dirName = isExplicitOrcagent ? 'orcagent' : 'oagent'

  const appData = app.getPath('appData')
  const targetUserData = join(appData, dirName)

  app.setPath('userData', targetUserData)
  app.setName(appName)

  seedOrcagentUserDataIfMissing(targetUserData, appName)
  ensureOrcagentTerminalBridgeSkill(targetUserData, appName)
  return true
}
