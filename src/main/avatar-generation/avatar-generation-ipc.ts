// Window-only: generate avatar options with a local image-capable agent. Desktop only, so no
// paired client or runtime RPC reaches this; the picked image saves through the normal upload.
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  AVATAR_IMAGE_AGENTS,
  MAX_AVATAR_DESCRIPTION_CHARS,
  type AvatarGenerationCapability,
  type AvatarGenerationResult
} from '../../shared/avatar-generation/avatar-generation-contract'
import {
  avatarGenerationPrompt,
  describesRealPerson
} from '../../shared/avatar-generation/avatar-generation-prompt'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/execution/commit-message-agent-environment'
import {
  probeAvatarGenerationCapability,
  type AvatarAgentEnv
} from './avatar-generation-capability'
import { runAvatarImageAgent } from './avatar-image-agent-run'

const GenerateArgs = z.object({
  requestId: z.string().min(1).max(128),
  description: z.string().trim().min(1).max(MAX_AVATAR_DESCRIPTION_CHARS),
  agent: z.enum(AVATAR_IMAGE_AGENTS)
})
const CancelArgs = z.object({ requestId: z.string().min(1).max(128) })

// Sign-in can change while the picker is open, so a probe is reused only briefly.
const CAPABILITY_TTL_MS = 30_000

export function registerAvatarGenerationHandlers(
  agentEnvironment: () => CommitMessageAgentEnvironmentResolvers | undefined
): void {
  const runs = new Map<string, AbortController>()
  let cached: { at: number; value: Promise<AvatarGenerationCapability> } | null = null

  // Never fall back to the default account when the selected one fails to prepare.
  const envFor: AvatarAgentEnv = async (agent) => {
    const prepared = await prepareLocalCommitMessageAgentEnv(agent, agentEnvironment())
    return prepared.ok ? prepared.env : null
  }
  const capability = (): Promise<AvatarGenerationCapability> => {
    if (!cached || Date.now() - cached.at > CAPABILITY_TTL_MS) {
      cached = { at: Date.now(), value: probeAvatarGenerationCapability(envFor) }
      // A failed probe must not stick for the whole TTL.
      cached.value.catch(() => {
        cached = null
      })
    }
    return cached.value
  }

  ipcMain.removeHandler('avatarGeneration:capability')
  ipcMain.handle('avatarGeneration:capability', () =>
    capability().catch((error: unknown) => {
      console.error('[avatar-generation] Capability probe failed:', error)
      return { agents: [] } satisfies AvatarGenerationCapability
    })
  )

  ipcMain.removeHandler('avatarGeneration:generate')
  ipcMain.handle(
    'avatarGeneration:generate',
    async (_event, raw: unknown): Promise<AvatarGenerationResult> => {
      const { requestId, description, agent } = GenerateArgs.parse(raw)
      // The renderer checks too; this keeps any other caller from skipping it.
      if (describesRealPerson(description)) {
        return { ok: false, error: 'real-person' }
      }
      // Registered before any await, so a cancel during the probe still lands.
      runs.get(requestId)?.abort()
      const controller = new AbortController()
      runs.set(requestId, controller)
      // The picker offers only agents the probe found; a stale pick is refused, not swapped.
      const found = (await capability().catch(() => null))?.agents.find(
        (entry) => entry.agent === agent
      )
      if (!found || found.status === 'signed-out') {
        if (runs.get(requestId) === controller) {
          runs.delete(requestId)
        }
        if (found) {
          // The next click probes again, so signing in elsewhere takes effect at once.
          cached = null
          return { ok: false, error: 'signed-out', agent }
        }
        return { ok: false, error: 'unavailable', agent }
      }
      try {
        const env = await envFor(agent)
        if (controller.signal.aborted) {
          return { ok: false, error: 'canceled', agent }
        }
        if (env === null) {
          return { ok: false, error: 'failed', agent }
        }
        const prompt = avatarGenerationPrompt(description)
        const outcome = await runAvatarImageAgent({
          agent,
          prompt,
          env,
          signal: controller.signal
        })
        if (controller.signal.aborted) {
          return { ok: false, error: 'canceled', agent }
        }
        if (outcome.ok) {
          return { ok: true, agent, image: outcome.image }
        }
        if (outcome.error === 'signed-out') {
          cached = null
        }
        return { ok: false, error: outcome.error, agent }
      } finally {
        if (runs.get(requestId) === controller) {
          runs.delete(requestId)
        }
      }
    }
  )

  ipcMain.removeHandler('avatarGeneration:cancel')
  ipcMain.handle('avatarGeneration:cancel', (_event, raw: unknown): void => {
    const { requestId } = CancelArgs.parse(raw)
    runs.get(requestId)?.abort()
  })
}
