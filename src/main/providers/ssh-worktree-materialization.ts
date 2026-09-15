import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { probeSshWorktreeMaterializationCapability } from './ssh-filesystem-provider-capabilities'

export async function requestSshWorktreeMaterialization(
  mux: SshChannelMultiplexer,
  source: string,
  target: string,
  linkedPaths: readonly string[],
  copyPaths?: readonly string[]
) {
  if (!(await probeSshWorktreeMaterializationCapability(mux))) {
    return { supported: false }
  }
  const supportsCopies =
    copyPaths !== undefined && (await probeSshWorktreeMaterializationCapability(mux, 2))
  const unsupportedWarning =
    copyPaths?.length && !supportsCopies
      ? 'This host needs an update to copy files from Repository settings. No shared links were substituted.'
      : undefined
  const result = await mux.request(
    'fs.materializeWorktreePaths',
    { source, target, linkedPaths, ...(supportsCopies ? { copyPaths } : {}) },
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
  const warning = [unsupportedWarning, 'warning' in result ? result.warning : undefined]
    .filter(Boolean)
    .join(' ')
  return { supported: result.supported, ...(warning ? { warning } : {}) }
}
