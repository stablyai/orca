import { existsSync } from 'node:fs'
import { Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentProtocol } from 'ssh2'

export const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

const MACOS_1PASSWORD_AGENT_SOCKET = [
  'Library',
  'Group Containers',
  '2BUA8C4S2C.com.1password',
  't',
  'agent.sock'
]
const LINUX_1PASSWORD_AGENT_SOCKET = ['.1password', 'agent.sock']

// Why: GUI-launched Electron inherits launchd's SSH_AUTH_SOCK (Apple's empty
// agent) — probe the 1Password socket too so keys stored there are found.
export function listAgentSocketCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const envSocket = env.SSH_AUTH_SOCK || undefined
  if (process.platform === 'win32') {
    // Why: named pipes are not visible to existsSync; connection errors count as 0 keys.
    return [...new Set([envSocket, WINDOWS_OPENSSH_AGENT_PIPE].filter(isPresent))]
  }
  const onePasswordSocket = join(
    homedir(),
    ...(process.platform === 'darwin' ? MACOS_1PASSWORD_AGENT_SOCKET : LINUX_1PASSWORD_AGENT_SOCKET)
  )
  return [...new Set([envSocket, onePasswordSocket].filter(isPresent))].filter((candidate) =>
    existsSync(candidate)
  )
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

// Why: createAgent()'s stream is private to the closure, so a wedged agent can
// never be destroyed on timeout — drive our own socket instead so we can.
export function countAgentIdentities(socketPath: string, timeoutMs = 500): Promise<number> {
  return new Promise((resolve) => {
    const stream = new Socket()
    let settled = false
    // Why: settle exactly once and always release the socket, even on timeout.
    const settle = (count: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.destroy()
      resolve(count)
    }
    const timer = setTimeout(() => settle(0), timeoutMs)
    stream.on('error', () => settle(0)).on('close', () => settle(0))
    stream.connect(socketPath, () => {
      const protocol = new AgentProtocol(true)
      protocol.on('error', () => settle(0))
      protocol.pipe(stream).pipe(protocol)
      protocol.getIdentities((error, keys) => settle(error ? 0 : (keys?.length ?? 0)))
    })
  })
}

// Why: module state is target-independent and last-writer-wins across concurrent
// connects is harmless — every attempt re-probes right before reading it.
let probedAgentSocket: string | undefined

export async function probePreferredAgentSocket(): Promise<string | undefined> {
  for (const candidate of listAgentSocketCandidates()) {
    if ((await countAgentIdentities(candidate)) > 0) {
      probedAgentSocket = candidate
      return candidate
    }
  }
  probedAgentSocket = undefined
  return undefined
}

export function getProbedAgentSocket(): string | undefined {
  return probedAgentSocket
}

/** @internal - tests need clean probe state between cases. */
export function _resetProbedAgentSocket(): void {
  probedAgentSocket = undefined
}
