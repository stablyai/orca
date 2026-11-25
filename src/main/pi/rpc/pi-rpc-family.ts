/** Pi and OMP share the jsonl-rpc protocol lineage; OMP's is a superset with a few renames. */
export type PiRpcFamilyAgent = 'pi' | 'omp'

export type PiRpcFamily = {
  agent: PiRpcFamilyAgent
  minimumVersions: readonly string[]
  /** Slash-command listing request; OMP renamed Pi's `get_commands`. */
  commandsRequest: 'get_commands' | 'get_available_commands'
  /** Version from which every prompt image is shrunk; null shrinks none conservatively. */
  shrinksEveryImageVersion: string | null
  /** Pi loads extra skill folders with `--skill`; OMP has no per-launch skill flag. */
  supportsSkillDirFlag: boolean
  /** Orca's Pi extension bridging background work; OMP has its own async runtime. */
  supportsBackgroundWorkBridge: boolean
  /** Pi's `--no-mcp` keeps limited launches free of MCP tools; OMP has no such flag. */
  supportsNoMcpFlag: boolean
  /** Tool names a read-only launch selects. */
  readTools: readonly string[]
}

export const PI_RPC_FAMILY_PI: PiRpcFamily = {
  agent: 'pi',
  minimumVersions: ['0.84.0'],
  commandsRequest: 'get_commands',
  shrinksEveryImageVersion: '1.5.1',
  supportsSkillDirFlag: true,
  supportsBackgroundWorkBridge: true,
  supportsNoMcpFlag: true,
  readTools: ['read', 'grep', 'find', 'ls']
}

export const PI_RPC_FAMILY_OMP: PiRpcFamily = {
  agent: 'omp',
  minimumVersions: ['19.0.0'],
  commandsRequest: 'get_available_commands',
  shrinksEveryImageVersion: null,
  supportsSkillDirFlag: false,
  supportsBackgroundWorkBridge: false,
  supportsNoMcpFlag: false,
  readTools: ['read', 'grep', 'glob']
}

export function piRpcFamilyFor(agent: string): PiRpcFamily {
  return agent === 'omp' ? PI_RPC_FAMILY_OMP : PI_RPC_FAMILY_PI
}
