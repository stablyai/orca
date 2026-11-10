// A9: agents are signed out of a sandbox before Orca deletes it, and an environment build's VM is
// scrubbed of agent sign-ins before it becomes an image other people boot.
//
// Both run the image's orca-agent-signout by source (`bash -c`), not by its installed path, so
// sandboxes booted from images built before the script existed get the same treatment.
import { VM_SCRIPT_SOURCES } from '../image/vm-scripts.generated'
import type { SandboxProviderApi } from './sandbox-provider'

export const AGENT_SIGNOUT_SCRIPT = VM_SCRIPT_SOURCES['orca-agent-signout']
/** Upper bound the delete waits for sign-out; the script gives each CLI 8 s. */
export const AGENT_SIGNOUT_TIMEOUT_MS = 20_000
const SCRUB_TIMEOUT_MS = 30_000

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }))

function signoutCommand(scrubOnly: boolean): { command: string; args: string[] } {
  return { command: 'bash', args: ['-c', AGENT_SIGNOUT_SCRIPT, 'orca-agent-signout', ...(scrubOnly ? ['--scrub-only'] : [])] }
}

/** True when the script ran and reports no credential file left. */
function scrubbed(result: { exitCode: number; stdout: string }): boolean {
  if (result.exitCode !== 0) {
    return false
  }
  try {
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { left?: unknown }
    return report.left === 0
  } catch {
    return false
  }
}

/**
 * Best effort and bounded: each agent's own logout, then its credential files, on the running VM.
 * Never throws and never takes longer than AGENT_SIGNOUT_TIMEOUT_MS, so it cannot block a delete.
 */
export async function signOutAgentsBeforeDelete(
  provider: SandboxProviderApi,
  sessionId: string,
  context: { sandboxId: string }
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), AGENT_SIGNOUT_TIMEOUT_MS)
  })
  try {
    const outcome = await Promise.race([
      provider.runCommand(sessionId, { ...signoutCommand(false), timeoutMs: AGENT_SIGNOUT_TIMEOUT_MS }),
      timedOut
    ])
    if (outcome === 'timeout') {
      log('sandbox_agent_signout', { sandboxId: context.sandboxId, ok: false, reason: 'timeout' })
      return false
    }
    const ok = scrubbed(outcome)
    log('sandbox_agent_signout', { sandboxId: context.sandboxId, ok, exitCode: outcome.exitCode })
    return ok
  } catch (error) {
    log('sandbox_agent_signout', { sandboxId: context.sandboxId, ok: false, error: String(error).slice(0, 120) })
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Removes agent credential files from a build VM before its snapshot. Fails closed: an image that
 * might carry someone's sign-in must not be handed to the rest of the team.
 */
export async function scrubAgentAuthForImage(provider: SandboxProviderApi, sessionId: string): Promise<boolean> {
  const result = await provider.runCommand(sessionId, { ...signoutCommand(true), timeoutMs: SCRUB_TIMEOUT_MS })
  return scrubbed(result)
}
