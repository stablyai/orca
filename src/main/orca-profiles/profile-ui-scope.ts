// Why: multi-profile management is downscoped to an accounts-first UX, not
// removed — the full switcher stays reachable behind this product-scope toggle
// (safe in packaged builds; it is not a security escape hatch).
export function isMultiProfileUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCA_MULTI_PROFILE_UI === '1'
}
