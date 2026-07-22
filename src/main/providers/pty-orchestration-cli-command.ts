export type PtyOrchestrationCliCommand =
  | { kind: 'posix-path'; executablePath: string }
  | { kind: 'powershell-path'; executablePath: string }
  | { kind: 'posix-env'; variableName: 'ORCA_CLI_COMMAND' }
  | { kind: 'powershell-env'; variableName: 'ORCA_CLI_COMMAND' }
  | { kind: 'cmd-env'; variableName: 'ORCA_CLI_COMMAND' }

export type PtyOrchestrationCliCommandResolver = (context: {
  isWsl: boolean
  shellPath: string | null
}) => PtyOrchestrationCliCommand | null
