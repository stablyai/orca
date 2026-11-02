import { z } from 'zod'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import type { CodexSandboxPolicy } from './codex-structured-sandbox-policy'

const configuration = z.object({
  config: z.object({
    sandbox_workspace_write: z
      .object({
        writable_roots: z.array(z.string()).default([]),
        network_access: z.boolean().default(false),
        exclude_tmpdir_env_var: z.boolean().default(false),
        exclude_slash_tmp: z.boolean().default(false)
      })
      .nullish()
  })
})
const requirements = z.object({ requirements: z.record(z.string(), z.unknown()).nullable() })

/** Only the legacy path with observable inputs is projected; managed/backend compilation stays Codex's. */
export async function readCodexAutoSandbox(
  connection: Pick<CodexAppServerConnection, 'request'>,
  input: { cwd: string; visualsFolder?: string },
  platform: NodeJS.Platform = process.platform
): Promise<CodexSandboxPolicy | undefined> {
  // Windows backend availability and managed selection are not exposed by config/read.
  if (platform === 'win32') {
    return undefined
  }
  try {
    const [rawConfig, rawRequirements] = await Promise.all([
      connection.request('config/read', { cwd: input.cwd }, { timeoutMs: 2_000 }),
      connection.request('configRequirements/read', {}, { timeoutMs: 2_000 })
    ])
    const { config } = configuration.parse(rawConfig)
    const { requirements: managed } = requirements.parse(rawRequirements)
    // The requirements API omits managed profile definitions and some backend constraints.
    if (managed !== null) {
      return undefined
    }
    const workspace = config.sandbox_workspace_write
    return {
      type: 'workspaceWrite',
      writableRoots: [
        ...new Set([
          ...(workspace?.writable_roots ?? []),
          ...(input.visualsFolder ? [input.visualsFolder] : [])
        ])
      ],
      networkAccess: workspace?.network_access ?? false,
      excludeTmpdirEnvVar: workspace?.exclude_tmpdir_env_var ?? false,
      excludeSlashTmp: workspace?.exclude_slash_tmp ?? false
    }
  } catch {
    return undefined
  }
}
