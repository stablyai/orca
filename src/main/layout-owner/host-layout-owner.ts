import {
  LAYOUT_OWNER_ENV,
  LAYOUT_OWNER_FLAG_FILE_NAME,
  LAYOUT_OWNER_RESOLVED_ENV,
  parseLayoutOwner,
  SERVER_LAYOUT_OWNER_ENV,
  type LayoutOwner
} from '../../shared/workspace-layout/layout-owner-startup'

// orcad imports this before anything else: never import the switch module here, or it evaluates first.

type Env = Record<string, string | undefined>

/** The built Electron main runs the same rules from its banner (config/build-plugins/layout-owner-banner.ts). */
export function resolveHostLayoutOwner(input: {
  server: boolean
  env: Env
  readFlag: () => string | undefined
}): { owner: LayoutOwner; warning: string | null } {
  const name = input.server ? SERVER_LAYOUT_OWNER_ENV : LAYOUT_OWNER_ENV
  // An empty value is unset, as a shell's `NAME=` means.
  let raw = input.env[name] || undefined
  let source = name
  if (raw === undefined && !input.server) {
    raw = input.readFlag()
    source = LAYOUT_OWNER_FLAG_FILE_NAME
  }
  if (raw === undefined) {
    return { owner: 'window', warning: null }
  }
  const owner = parseLayoutOwner(raw)
  return owner
    ? { owner, warning: null }
    : {
        owner: 'window',
        warning: `[layout-owner] unknown ${source} value ${JSON.stringify(raw)}; using the window path`
      }
}

/** orcad's own value: only the server setting, never one inherited from the desktop that started it. */
export function settleServerLayoutOwnerEnv(env: Env = process.env): void {
  const { owner, warning } = resolveHostLayoutOwner({
    server: true,
    env,
    readFlag: () => undefined
  })
  if (warning) {
    console.warn(warning)
  }
  delete env[LAYOUT_OWNER_ENV]
  env[LAYOUT_OWNER_RESOLVED_ENV] = owner
}
