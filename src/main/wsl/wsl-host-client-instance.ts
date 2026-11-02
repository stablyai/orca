/** R39: names this Orca installation to a WSL host's server, so desktops sharing one server tell apart. */
import { createHash } from 'node:crypto'
import { getAppEnvironment } from '../../shared/app-environment'

let cached: string | null = null

/** Stable per userData folder, so stable and dev Orca on one account differ; reveals no path. */
export function wslHostClientInstanceId(): string {
  cached ??= createHash('sha256')
    .update(getAppEnvironment().getPath('userData'))
    .digest('base64url')
    .slice(0, 32)
  return cached
}
