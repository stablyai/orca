// Why: these on-disk names are shared between the hook service (which writes
// the dirs) and the orphaned-dir GC sweep (which must recognize exactly the
// same names). A separate module avoids a hook-service <-> gc import cycle and
// keeps the GC importable without electron.

export const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
export const OPENCODE_LEGACY_HOOKS_DIR = 'opencode-hooks'
export const OPENCODE_OVERLAY_DIR = 'opencode-config-overlays'
export const OPENCODE_SHARED_CONFIG_DIR = 'shared'
export const OPENCODE_OVERLAY_MANIFEST_FILE = '.orca-opencode-overlay-manifest.json'
