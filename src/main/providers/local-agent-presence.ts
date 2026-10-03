import { captureWindowsAgentPresence, probeWindowsPtyAgentPresence } from './windows-agent-presence'
import type {
  AgentPresenceCaptureOptions,
  AgentProcessIdentity
} from '../../shared/agent-process-presence'
import { captureAgentForegroundIdentity } from '../../shared/agent-foreground-identity'
import { createPtyForegroundResolver } from '../daemon/pty-subprocess/spawn-file-foreground-process'
import {
  ptyProcesses,
  ptyWslDistroById,
  ptyAgentForegroundContextPaths,
  ptyLastRecognizedForeground
} from './local-pty-provider-state'

export async function captureLocalAgentPresence(id: string, options?: AgentPresenceCaptureOptions) {
  const proc = ptyProcesses.get(id)
  // WSL needs a guest-shell binding; native Windows awaits its job-proof capability.
  if (!proc || ptyWslDistroById.get(id)) {
    return undefined
  }
  if (process.platform === 'win32') {
    const observed = ptyLastRecognizedForeground.get(id)
    if (!observed?.pid || Date.now() - observed.at > 1_000) {
      return undefined
    }
    const presence = await captureWindowsAgentPresence(proc, {
      available: true,
      processName: observed.name,
      processId: observed.pid,
      processStartTime: observed.processStartTime
    })
    return ptyProcesses.get(id) === proc ? presence : undefined
  }
  const presence = await captureAgentForegroundIdentity(() =>
    createPtyForegroundResolver(proc)(proc.pid, proc.process || null, {
      contextPaths: ptyAgentForegroundContextPaths.get(id),
      ...options
    })
  )
  return ptyProcesses.get(id) === proc ? presence : undefined
}

export async function probeLocalAgentPresence(id: string, identity: AgentProcessIdentity) {
  const proc = ptyProcesses.get(id)
  return proc && !ptyWslDistroById.get(id)
    ? probeWindowsPtyAgentPresence(proc, identity)
    : ('unverifiable' as const)
}
