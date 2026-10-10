/** A fake host's test for the capture's own tar flag: a random fence token can contain `-cf`. */
export function isSnapshotCaptureCommand(command: string): boolean {
  return /\btar -C \S+ -cf /u.test(command)
}
