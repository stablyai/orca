/**
 * The running server's terminal admission, held closed from the moment it begins to stop until it
 * exits: a terminal admitted then would die with it, uncounted, whatever a census asked.
 */
let runningTerminalAdmission: { holdUntilExit(): void } | null = null
// A stop can begin during startup, before the runtime binds its admission.
let stopBegan = false

export function bindOrcadStopTerminalAdmission(admission: { holdUntilExit(): void }): void {
  runningTerminalAdmission = admission
  if (stopBegan) {
    admission.holdUntilExit()
  }
}

export function holdOrcadTerminalAdmissionUntilExit(): void {
  stopBegan = true
  runningTerminalAdmission?.holdUntilExit()
}
