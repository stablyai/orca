/**
 * Audits the commands a pinned-Node deploy sent a Windows host, decoded the way the host runs
 * them: runtime-compiled P/Invoke (`Add-Type`) is an EDR signal the pinned path must not emit
 * (docs/reference/windows-edr-posture.md, design D5).
 */
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'

/** The stage-fencing prelude that reads file identities through the verified node.exe. */
const NODE_STAGE_IDENTITY_MARKER = '$orcaIdentityNode'
const ADD_TYPE = /\bAdd-Type\b/iu

export type WindowsSessionCommandAudit = {
  commandCount: number
  addTypeCommands: number
  nodeStageIdentityCommands: number
}

export function auditWindowsSessionCommands(
  commands: readonly string[]
): WindowsSessionCommandAudit {
  const scripts = commands.map((command) => decodeRemotePowerShellScript(command))
  return {
    commandCount: scripts.length,
    addTypeCommands: scripts.filter((script) => ADD_TYPE.test(script)).length,
    nodeStageIdentityCommands: scripts.filter((script) =>
      script.includes(NODE_STAGE_IDENTITY_MARKER)
    ).length
  }
}

/** Empty when the audit holds; `uploaded` means this deploy staged files onto the host. */
export function windowsSessionCommandViolations(
  audit: WindowsSessionCommandAudit,
  options: { uploaded: boolean }
): string[] {
  const violations: string[] = []
  if (audit.addTypeCommands > 0) {
    violations.push(`${audit.addTypeCommands} of ${audit.commandCount} commands ran Add-Type`)
  }
  if (options.uploaded && audit.nodeStageIdentityCommands === 0) {
    violations.push('no upload stage read file identities through the pinned node.exe')
  }
  return violations
}
