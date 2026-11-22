import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

export async function mintGatewayCredential(profile, env = process.env) {
  const inherited = env.LLM_GATEWAY_TOKEN?.trim()
  if (inherited) {
    return inherited
  }
  const command = profile.credentialCommand ?? join(homedir(), 'bin', 'llm-gateway-key.sh')
  const result = await runProcess({
    program: command,
    env,
    timeoutMs: 15_000,
    maxOutputBytes: 16_384,
    killOnOutputLimit: true
  })
  if (result.code !== 0 || result.outputTruncated || !result.stdout.trim()) {
    throw new Error('No gateway credential is available from the per-profile handoff')
  }
  const token = result.stdout.trim()
  return token
}
