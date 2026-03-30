import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import { getDefaultRepoHookSettings } from '../shared/constants'
import type { OrcaHooks, Repo } from '../shared/types'

const HOOK_TIMEOUT = 120_000 // 2 minutes
type HookName = keyof OrcaHooks['scripts']

function getHookShell(): string | undefined {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }

  return '/bin/bash'
}

/**
 * Parse a simple orca.yaml file. Handles only the `scripts:` block with
 * multiline string values (YAML block scalar `|`).
 */
export function parseOrcaYaml(content: string): OrcaHooks | null {
  const hooks: OrcaHooks = { scripts: {} }

  // Match top-level "scripts:" block
  const scriptsMatch = content.match(/^scripts:\s*$/m)
  if (!scriptsMatch) {
    return null
  }

  const afterScripts = content.slice(scriptsMatch.index! + scriptsMatch[0].length)
  // [Fix]: Split using /\r?\n/ instead of '\n'. Otherwise, on Windows, trailing \r characters
  // stay attached to script commands, which causes fatal '\r command not found' errors in WSL/bash.
  const lines = afterScripts.split(/\r?\n/)

  let currentKey: 'setup' | 'archive' | null = null
  let currentValue = ''

  for (const line of lines) {
    // Another top-level key (not indented) — stop parsing scripts block
    if (/^\S/.test(line) && line.trim().length > 0) {
      break
    }

    // Indented key like "  setup: |" or "  archive: |"
    const keyMatch = line.match(/^  (setup|archive):\s*\|?\s*$/)
    if (keyMatch) {
      // Save previous key
      if (currentKey) {
        hooks.scripts[currentKey] = currentValue.trimEnd()
      }
      currentKey = keyMatch[1] as 'setup' | 'archive'
      currentValue = ''
      continue
    }

    // Content line (indented by 4+ spaces under a key)
    if (currentKey && line.startsWith('    ')) {
      currentValue += `${line.slice(4)}\n`
    }
  }

  // Save last key
  if (currentKey) {
    hooks.scripts[currentKey] = currentValue.trimEnd()
  }

  if (!hooks.scripts.setup && !hooks.scripts.archive) {
    return null
  }
  return hooks
}

/**
 * Load hooks from orca.yaml in the given repo root.
 */
export function loadHooks(repoPath: string): OrcaHooks | null {
  const yamlPath = join(repoPath, 'orca.yaml')
  if (!existsSync(yamlPath)) {
    return null
  }

  try {
    const content = readFileSync(yamlPath, 'utf-8')
    return parseOrcaYaml(content)
  } catch {
    return null
  }
}

/**
 * Check whether an orca.yaml exists for a repo.
 */
export function hasHooksFile(repoPath: string): boolean {
  return existsSync(join(repoPath, 'orca.yaml'))
}

export function getEffectiveHooks(repo: Repo): OrcaHooks | null {
  const defaults = getDefaultRepoHookSettings()
  const yamlHooks = loadHooks(repo.path)
  const repoSettings = {
    ...defaults,
    ...repo.hookSettings,
    scripts: {
      ...defaults.scripts,
      ...repo.hookSettings?.scripts
    }
  }

  const hooks: OrcaHooks = { scripts: {} }

  for (const hookName of ['setup', 'archive'] as HookName[]) {
    const yamlScript = yamlHooks?.scripts[hookName]?.trim()
    const uiScript = repoSettings.scripts[hookName].trim()

    const autoScript = yamlScript || uiScript || undefined
    const effectiveScript = repoSettings.mode === 'auto' ? autoScript : uiScript || undefined

    if (effectiveScript) {
      hooks.scripts[hookName] = effectiveScript
    }
  }

  if (!hooks.scripts.setup && !hooks.scripts.archive) {
    return null
  }
  return hooks
}

/**
 * Run a named hook script in the given working directory.
 */
export function runHook(
  hookName: 'setup' | 'archive',
  cwd: string,
  repo: Repo
): Promise<{ success: boolean; output: string }> {
  const hooks = getEffectiveHooks(repo)
  const script = hooks?.scripts[hookName]

  if (!script) {
    return Promise.resolve({ success: true, output: '' })
  }

  return new Promise((resolve) => {
    exec(
      script,
      {
        cwd,
        timeout: HOOK_TIMEOUT,
        shell: getHookShell(),
        env: {
          ...process.env,
          ORCA_ROOT_PATH: repo.path,
          ORCA_WORKTREE_PATH: cwd,
          // Compat with conductor.json users
          CONDUCTOR_ROOT_PATH: repo.path,
          GHOSTX_ROOT_PATH: repo.path
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[hooks] ${hookName} hook failed in ${cwd}:`, error.message)
          resolve({
            success: false,
            output: `${stdout}\n${stderr}\n${error.message}`.trim()
          })
        } else {
          console.log(`[hooks] ${hookName} hook completed in ${cwd}`)
          resolve({
            success: true,
            output: `${stdout}\n${stderr}`.trim()
          })
        }
      }
    )
  })
}
