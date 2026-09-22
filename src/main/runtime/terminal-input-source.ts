// Why: the runtime already knows which paired device wrote into a PTY (RpcContext carries
// pairedDeviceId and clientKind), but nothing kept it. Agent hooks only see launch-time env,
// so this is the one record they can read back to learn where the user is typing from.

export type TerminalInputSource = {
  /** Paired device that sent the input; null for in-process input (desktop renderer, CLI). */
  pairedDeviceId: string | null
  /** Device name from the pairing registry, resolved at read time; null when unknown. */
  deviceName: string | null
  clientKind: 'mobile' | 'runtime' | 'local'
  /** Milliseconds since epoch when the PTY accepted the input. */
  at: number
}

/** Caller identity as an RPC handler sees it; both fields are absent for in-process callers. */
export type TerminalInputCaller = {
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
}
