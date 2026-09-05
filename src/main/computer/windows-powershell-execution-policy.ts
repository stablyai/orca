export type WindowsPowerShellExecutionPolicy = 'RemoteSigned' | 'Bypass'

export function buildWindowsPowerShellFileArgs(
  scriptPath: string,
  operationPath: string,
  executionPolicy: WindowsPowerShellExecutionPolicy
): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    executionPolicy,
    '-File',
    scriptPath,
    operationPath
  ]
}

const POWERSHELL_POLICY_BLOCK_SIGNATURES = [
  'running scripts is disabled',
  'cannot run this script on the current system'
] as const

export function isPowerShellExecutionPolicyBlocked(text: string): boolean {
  const haystack = text.toLowerCase()
  return POWERSHELL_POLICY_BLOCK_SIGNATURES.some((signature) => haystack.includes(signature))
}
