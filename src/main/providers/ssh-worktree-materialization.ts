import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { probeSshWorktreeMaterializationCapability } from './ssh-filesystem-provider-capabilities'

export async function requestSshWorktreeMaterialization(
  mux: SshChannelMultiplexer,
  source: string,
  target: string,
  linkedPaths: readonly string[]
) {
  if (!(await probeSshWorktreeMaterializationCapability(mux))) {
    return { supported: false }
  }
  const result = await mux.request(
    'fs.materializeWorktreePaths',
    { source, target, linkedPaths },
    { timeoutMs: 300_000 }
  )
  if (
    !result ||
    typeof result !== 'object' ||
    !('supported' in result) ||
    typeof result.supported !== 'boolean' ||
    ('warning' in result && result.warning !== undefined && typeof result.warning !== 'string')
  ) {
    throw new Error('Invalid host materialization response')
  }
  return {
    supported: result.supported,
    ...('warning' in result && typeof result.warning === 'string'
      ? { warning: result.warning }
      : {})
  }
}
