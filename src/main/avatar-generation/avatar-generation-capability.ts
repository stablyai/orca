// Which installed agent can make an avatar right now: Codex first, then Grok.
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AVATAR_IMAGE_AGENTS,
  type AvatarGenerationCapability,
  type AvatarImageAgent
} from '../../shared/avatar-generation/avatar-generation-contract'
import { resolveGrokHomeDir } from '../../shared/agent-hook-listener/providers/grok/grok-session-paths'
import { spawnSourceControlAgent } from '../text-generation/execution/source-control-agent-launch'
import { killSourceControlAgentProcess } from '../text-generation/execution/source-control-agent-termination'

const PROBE_TIMEOUT_MS = 10_000

type AgentProbe = 'ready' | 'signed-out' | 'unavailable'

/** stdout of a quick, prompt-free CLI call, or null when it can't run or fails. */
function quickOutput(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnSourceControlAgent>
    try {
      child = spawnSourceControlAgent({
        binary,
        args,
        env,
        stdinMode: 'ignore',
        useCwdForNative: false
      })
    } catch {
      resolve(null)
      return
    }
    let stdout = ''
    const timer = setTimeout(() => {
      void killSourceControlAgentProcess(child).catch(() => {})
      resolve(null)
    }, PROBE_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve(code === 0 ? stdout : null)
    })
  })
}

/** `codex features list` prints one `name  stage  enabled` row per feature. */
export function codexImageGenerationEnabled(featureList: string): boolean {
  return /^image_generation\s+.*\btrue\s*$/m.test(featureList)
}

async function probeCodex(env: NodeJS.ProcessEnv | undefined): Promise<AgentProbe> {
  const features = await quickOutput('codex', ['features', 'list'], env)
  if (features === null || !codexImageGenerationEnabled(features)) {
    return 'unavailable'
  }
  // Codex's own check covers keyring logins too, which keep no auth.json.
  return (await quickOutput('codex', ['login', 'status'], env)) === null ? 'signed-out' : 'ready'
}

async function probeGrok(env: NodeJS.ProcessEnv | undefined): Promise<AgentProbe> {
  if ((await quickOutput('grok', ['--version'], env)) === null) {
    return 'unavailable'
  }
  if ((env ?? process.env).XAI_API_KEY) {
    return 'ready'
  }
  return access(join(resolveGrokHomeDir(env ?? process.env), 'auth.json')).then(
    () => 'ready',
    () => 'signed-out'
  )
}

/** `null` env: the agent's selected account couldn't be prepared, so it must not run. */
export type AvatarAgentEnv = (
  agent: AvatarImageAgent
) => Promise<NodeJS.ProcessEnv | undefined | null>

const AGENT_PROBES: Record<
  AvatarImageAgent,
  (env: NodeJS.ProcessEnv | undefined) => Promise<AgentProbe>
> = { codex: probeCodex, grok: probeGrok }

export async function probeAvatarGenerationCapability(
  envFor: AvatarAgentEnv
): Promise<AvatarGenerationCapability> {
  const probes = await Promise.all(
    AVATAR_IMAGE_AGENTS.map(async (agent) => {
      const env = await envFor(agent)
      if (env === null) {
        return { agent, probe: 'unavailable' as const }
      }
      return { agent, probe: await AGENT_PROBES[agent](env) }
    })
  )
  return {
    agents: probes.flatMap(({ agent, probe }) =>
      probe === 'unavailable' ? [] : [{ agent, status: probe }]
    )
  }
}
