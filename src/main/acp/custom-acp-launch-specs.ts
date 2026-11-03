import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { GENERIC_ACP_DIALECT } from './acp-dialects/acp-dialect'
import { directoryAccountBinding } from './acp-account-binding'
import { CustomAcpAgentsConfig, type CustomAcpAgentConfig } from './custom-acp-agent-config'
import type { AcpLaunchSpec } from './acp-launch-specs'

const MAX_CONFIG_BYTES = 256 * 1024
export const CUSTOM_ACP_AGENTS_CONFIG_ENV = 'ORCA_CUSTOM_AGENT_ADAPTERS'

export function customAcpLaunchSpec(config: CustomAcpAgentConfig): AcpLaunchSpec {
  const account = directoryAccountBinding(config.account.variable, () => config.account.directory)
  return {
    agent: config.id,
    displayName: config.name ?? config.id,
    command: config.command,
    ignoreAgentCommandSetting: true,
    args: () => [...config.args],
    env: { ...config.env },
    dialect: GENERIC_ACP_DIALECT,
    loginCommand: [],
    account: {
      ...account,
      resolve: async () => ({ variable: config.account.variable, path: config.account.directory })
    },
    installDirectories: () => [],
    modelDiscovery: {
      kind: 'unavailable',
      reason: 'Custom ACP adapters report their models when the chat starts'
    },
    transcriptImport: null,
    sessionHistory: {
      rowAgents: [],
      rowSessionId: (link) => link.handle.nativeId,
      parseResumeArgs: () => null
    }
  }
}

function readConfig(path: string): unknown {
  if (!isAbsolute(path)) {
    throw new Error('Custom adapter configuration requires an absolute path')
  }
  const fd = openSync(path, 'r')
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error('Custom adapter configuration must be a regular file')
    }
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null)
      if (!read) {
        break
      }
      length += read
    }
    if (length > MAX_CONFIG_BYTES) {
      throw new Error('Custom adapter configuration is too large')
    }
    return JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

/** Only an explicit host startup path can authorize adapter executables. */
export function loadCustomAcpLaunchSpecs(
  path = process.env[CUSTOM_ACP_AGENTS_CONFIG_ENV],
  warn: (message: string) => void = console.warn
): readonly AcpLaunchSpec[] {
  if (!path) {
    return []
  }
  try {
    return CustomAcpAgentsConfig.parse(readConfig(path)).agents.map(customAcpLaunchSpec)
  } catch {
    // Validation errors can contain credentials from the configuration.
    warn(
      '[native-chat] Custom ACP adapters were not loaded. Check the versioned host configuration.'
    )
    return []
  }
}
