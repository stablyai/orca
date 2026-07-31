import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const BINARY_NAME = process.platform === 'win32' ? 'codex-micro.exe' : 'codex-micro'

type ResolveOptions = {
  allowOverride?: boolean
  override?: string
  packaged?: boolean
  resourcesPath?: string
}

export function resolveCodexMicroSidecarPath(options: ResolveOptions = {}): string | null {
  const defaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
  const packaged = options.packaged ?? (Boolean(process.resourcesPath) && !defaultApp)
  const allowOverride = options.allowOverride ?? defaultApp
  const override = options.override ?? process.env.ORCA_CODEX_MICRO_SIDECAR_PATH
  if (allowOverride && override && isAbsolute(override) && isExecutableFile(override)) {
    return override
  }

  const packagedCandidate = join(
    options.resourcesPath ?? process.resourcesPath ?? '',
    'codex-micro',
    BINARY_NAME
  )
  if (packaged) {
    return isExecutableFile(packagedCandidate) ? packagedCandidate : null
  }
  const dev = [
    join(process.cwd(), 'native/codex-micro/target/debug', BINARY_NAME),
    join(process.cwd(), 'native/codex-micro/target/release', BINARY_NAME),
    resolve(__dirname, '../../native/codex-micro/target/debug', BINARY_NAME),
    resolve(__dirname, '../../native/codex-micro/target/release', BINARY_NAME)
  ]
  return dev.find(isExecutableFile) ?? null
}

function isExecutableFile(candidate: string): boolean {
  if (!candidate || !existsSync(candidate)) {
    return false
  }
  try {
    const stat = statSync(candidate)
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)
  } catch {
    return false
  }
}
