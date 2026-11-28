// Orca's permission vocabulary onto zcode's collaboration mode (Build/Plan rides separately:
// `plan` is an interaction mode, not a permission).

const PERMISSION_MODES_BY_ZCODE_MODE: Record<string, string> = {
  build: 'ask',
  edit: 'accept-edits',
  auto: 'auto',
  yolo: 'full-access'
}

/** The zcode collaboration mode a session reports, as Orca's permission vocabulary. */
export function permissionModeOfZcodeMode(mode: string | null): string | undefined {
  return mode ? PERMISSION_MODES_BY_ZCODE_MODE[mode] : undefined
}

/** The zcode collaboration mode an Orca permission pick writes; undefined has no equivalent. */
export function zcodeModeOfPermissionMode(permissionMode: string): string | undefined {
  for (const [mode, permission] of Object.entries(PERMISSION_MODES_BY_ZCODE_MODE)) {
    if (permission === permissionMode) {
      return mode
    }
  }
  return undefined
}
