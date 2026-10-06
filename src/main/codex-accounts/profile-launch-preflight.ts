// File authority is rechecked around the provider observation, never inferred from account labels.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { AgentProfileSnapshot } from '../../shared/agent-launch-profile'
import { observeAgentStateFile } from '../codex/codex-path-observation'
import { readCodexAuthIdentity } from './codex-auth-identity'
import { hasCodexOAuthCredential } from './managed-codex-auth-readiness'
import { assertCodexProfileConfigFileAuthority } from './profile-config-authority'
import { observeCodexProfileLaunchAuthority } from './profile-launch-authority'
import { AgentProfilePreparationError } from '../agent-profiles/preparation-error'

function credentialIdentity(snapshot: AgentProfileSnapshot): string {
  const bytes = readFileSync(join(snapshot.resolvedHome, 'auth.json'), 'utf8')
  const identity = readCodexAuthIdentity(bytes)
  if (
    !hasCodexOAuthCredential(bytes) ||
    !identity ||
    snapshot.identity.kind !== 'verified' ||
    snapshot.identity.subject !==
      JSON.stringify([
        'codex',
        identity.email,
        identity.providerAccountId,
        identity.workspaceAccountId
      ])
  ) {
    throw new AgentProfilePreparationError('codex_policy')
  }
  return JSON.stringify([identity.email, identity.providerAccountId, identity.workspaceAccountId])
}
export async function validateManagedCodexProfileLaunch(
  snapshot: AgentProfileSnapshot,
  context: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  if (snapshot.agent !== 'codex' || snapshot.binding.kind !== 'managed') {
    return
  }
  // Unsupported managed startup layers can choose a credential store before RPC is available.
  for (const path of [
    '/etc/codex/managed_config.toml',
    '/etc/codex/requirements.toml',
    ...(process.platform === 'darwin'
      ? ['/Library/Managed Preferences/com.openai.codex.plist']
      : [])
  ]) {
    if (observeAgentStateFile(path).kind !== 'absent') {
      throw new AgentProfilePreparationError('codex_policy')
    }
  }
  assertCodexProfileConfigFileAuthority('/etc/codex/config.toml')
  assertCodexProfileConfigFileAuthority(join(snapshot.resolvedHome, 'config.toml'))
  let cwd = resolve(context.cwd)
  while (true) {
    assertCodexProfileConfigFileAuthority(join(cwd, '.codex', 'config.toml'))
    const parent = dirname(cwd)
    if (parent === cwd) {
      break
    }
    cwd = parent
  }
  const before = credentialIdentity(snapshot)
  await observeCodexProfileLaunchAuthority({ snapshot, ...context })
  if (credentialIdentity(snapshot) !== before) {
    throw new AgentProfilePreparationError('codex_policy')
  }
}
