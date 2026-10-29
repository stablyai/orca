import { serializeClaudeAgentViewConfig } from './agent-view-config-lock'
import {
  ownership,
  markerName,
  planClaudeAgentViewInstall,
  planClaudeAgentViewDisable,
  withoutOwnedBinding
} from './agent-view-binding-plan'
import { dirname, join, posix } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import type { SFTPWrapper } from 'ssh2'
import {
  readHooksJson,
  writeHooksJson,
  writeHooksJsonAsync,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import { parseHooksJsonText, readHooksJsonWithRaw } from '../agent-hooks/hooks-json-read'
import {
  claudeAgentViewChord,
  parseClaudeAgentViewBindings,
  serializeClaudeAgentViewBindings
} from './agent-view-keybindings'
import {
  readHooksJsonRemote,
  readTextFileRemote,
  writeHooksJsonRemote,
  renamePlain
} from '../agent-hooks/installer-utils-remote'
import { CLAUDE_AGENT_VIEW_PLUGIN } from '../../shared/claude-agent-view'
export { withClaudeAgentViewShortcut } from './agent-view-binding-plan'
export { ensureClaudeAgentViewPlugin } from './agent-view-plugin'

// Called only after the user opts in; a surviving marker remembers deletions and edited chords.
export function installClaudeAgentView(configPath: string): boolean {
  const configDir = dirname(configPath)
  const keybindings = join(configDir, 'keybindings.json')
  const { raw } = readHooksJsonWithRaw(keybindings)
  const config = raw === null ? readHooksJson(keybindings) : parseClaudeAgentViewBindings(raw)
  if (!config) {
    return false
  }
  const marker = join(configDir, markerName)
  const legacyRoot = join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const legacy = readHooksJson(join(legacyRoot, '.claude-plugin', 'orca-managed.json'))
  if (legacy?.owner === ownership.owner) {
    writeHooksJson(marker, { ...legacy, setup: 'attempted' })
    rmSync(legacyRoot, { recursive: true, force: true })
    return claudeAgentViewChord(raw ?? '') !== undefined
  }
  const previous = existsSync(marker) ? readHooksJson(marker) : undefined
  const plan = planClaudeAgentViewInstall(raw, config, previous)
  if (plan.marker) {
    writeHooksJson(marker, plan.marker)
    writeHooksJson(keybindings, plan.config, {
      serialized: serializeClaudeAgentViewBindings(raw, plan.config)
    })
  }
  return plan.supported
}

export function removeClaudeAgentView(configPath: string): void {
  const configDir = dirname(configPath)
  const root = join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const legacy = readHooksJson(join(root, '.claude-plugin', 'orca-managed.json'))
  const markerPath = join(configDir, markerName)
  const marker = legacy?.owner === ownership.owner ? legacy : readHooksJson(markerPath)
  if (marker?.owner !== ownership.owner) {
    return
  }
  const keybindings = join(configDir, 'keybindings.json')
  const { raw } = readHooksJsonWithRaw(keybindings)
  const config = raw === null ? readHooksJson(keybindings) : parseClaudeAgentViewBindings(raw)
  const plan = planClaudeAgentViewDisable(config, marker)
  writeHooksJson(markerPath, plan.marker)
  if (plan.config && JSON.stringify(config) !== JSON.stringify(plan.config)) {
    writeHooksJson(keybindings, plan.config, {
      serialized: serializeClaudeAgentViewBindings(raw, plan.config)
    })
  }
  if (legacy?.owner === ownership.owner) {
    rmSync(root, { recursive: true, force: true })
  }
}

function retirementMarker(
  previous: HooksConfig | null,
  legacy: HooksConfig,
  config: HooksConfig | null
): HooksConfig {
  const removed = config && withoutOwnedBinding(config, legacy)
  return {
    ...(previous?.owner === ownership.owner ? previous : { ...legacy, setup: 'attempted' }),
    ...(config && JSON.stringify(config) !== JSON.stringify(removed) ? { setup: 'pending' } : {}),
    cleanupPending: !config
  }
}

export function refreshClaudeAgentView(configPath: string): Promise<void> {
  return serializeClaudeAgentViewConfig(configPath, () => retireLegacyClaudeAgentView(configPath))
}

async function retireLegacyClaudeAgentView(configPath: string): Promise<void> {
  const configDir = dirname(configPath)
  const root = join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const legacy = parseHooksJsonText(
    await readFile(join(root, '.claude-plugin', 'orca-managed.json'), 'utf8').catch(() => '{}')
  )
  const markerPath = join(configDir, markerName)
  const previous = parseHooksJsonText(await readFile(markerPath, 'utf8').catch(() => '{}'))
  const marker =
    legacy?.owner === ownership.owner ? legacy : previous?.cleanupPending === true ? previous : null
  if (marker?.owner !== ownership.owner) {
    return
  }
  const keybindings = join(configDir, 'keybindings.json')
  const raw = await readFile(keybindings, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    console.warn('[agent-hooks] Claude agent view binding cleanup deferred', error)
    return undefined
  })
  const config = raw === undefined ? null : parseClaudeAgentViewBindings(raw)
  await writeHooksJsonAsync(markerPath, retirementMarker(previous, marker, config))
  if (config && raw !== undefined) {
    const next = withoutOwnedBinding(config, marker)
    if (JSON.stringify(config) !== JSON.stringify(next)) {
      await writeHooksJsonAsync(keybindings, next, {
        serialized: serializeClaudeAgentViewBindings(raw, next)
      })
    }
  }
  if (legacy?.owner === ownership.owner) {
    await rm(root, { recursive: true, force: true })
  }
}

export async function removeClaudeAgentViewRemote(
  sftp: SFTPWrapper,
  configPath: string
): Promise<void> {
  const configDir = posix.dirname(configPath)
  const root = posix.join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const legacy = await readHooksJsonRemote(
    sftp,
    posix.join(root, '.claude-plugin', 'orca-managed.json')
  )
  const markerPath = posix.join(configDir, markerName)
  const previous = await readHooksJsonRemote(sftp, markerPath)
  const marker =
    legacy?.owner === ownership.owner ? legacy : previous?.cleanupPending === true ? previous : null
  if (marker?.owner !== ownership.owner) {
    return
  }
  const keybindings = posix.join(configDir, 'keybindings.json')
  const raw = await readTextFileRemote(sftp, keybindings).catch((error: unknown) => {
    console.warn('[agent-hooks] Remote Claude agent view binding cleanup deferred', error)
    return undefined
  })
  const config = raw === undefined ? null : parseClaudeAgentViewBindings(raw)
  await writeHooksJsonRemote(sftp, markerPath, retirementMarker(previous, marker, config))
  if (config && raw !== undefined) {
    const next = withoutOwnedBinding(config, marker)
    if (JSON.stringify(config) !== JSON.stringify(next)) {
      await writeHooksJsonRemote(sftp, keybindings, next, {
        serialized: serializeClaudeAgentViewBindings(raw, next)
      })
    }
  }
  if (legacy?.owner === ownership.owner) {
    await renamePlain(sftp, root, posix.join(configDir, `orca-agent-view-retired-${randomUUID()}`))
  }
}
