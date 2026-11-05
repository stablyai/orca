import { readFileSync } from 'node:fs'

/** The import whose absence tells the patched binary from the published prebuilt. */
export const FLAGGED_ADDON_IMPORT = 'ReadProcessMemory'

/**
 * Refuse a staged relay addon built from unpatched source.
 *
 * The build asserts this on the artifact it produces, but a relay bundle and the
 * addon beside it are redeployed independently: a host that has not taken a new
 * bundle keeps whatever `.node` is already there, and the published prebuilt is
 * node-addon-api, so it binds cleanly and then opens every process with
 * `PROCESS_VM_READ` to walk its PEB -- the primitive MDE scores as credential
 * dumping. Nothing checked that at load until here.
 *
 * Same predicate as `inspectWindowsProcessTreeAddon` in
 * `config/scripts/windows-process-tree-gyp-rebuild.mjs`, which cannot be
 * imported here: it is install-time tooling that pulls in node-gyp and
 * `child_process`, and this module is bundled into the app and the relay.
 *
 * Falling back to the CIM scan is the correct loss: it is slower, and it is not
 * the thing an EDR quarantines the host for.
 */
export function stagedRelayAddonIsUnpatched(addonPath: string | undefined): boolean {
  // No resolver means an injected test double, so there is no file to inspect.
  // Production always has one, and a require that just succeeded proves the
  // path is readable -- "cannot tell" here is never a real deployment.
  if (!addonPath) {
    return false
  }
  try {
    return readFileSync(addonPath).includes(FLAGGED_ADDON_IMPORT)
  } catch {
    return false
  }
}
