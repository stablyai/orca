/** Match tar's actual capture flag; random fence tokens may also contain -cf. */
export function isSnapshotCaptureCommand(command: string): boolean {
  return /\btar -C \S+ -cf /u.test(command)
}
