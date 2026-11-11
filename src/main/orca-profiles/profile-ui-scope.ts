// Packaged builds may opt into the full profile switcher; this is a product-scope toggle.
export function isMultiProfileUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCA_MULTI_PROFILE_UI === '1'
}
