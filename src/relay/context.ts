import { resolve } from 'path'
import { homedir } from 'os'

// Why: Node's fs APIs don't understand shell tilde expansion. Old repos may
// have been stored with `~` or `~/…` paths before the client-side fix, so the
// relay must expand them to absolute paths as a safety net.
export function expandTilde(p: string): string {
  if (p === '~' || p === '~/') {
    return homedir()
  }
  if (p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2))
  }
  return p
}

// Why: the relay runs as the SSH user and trusts the renderer process. A
// compromised renderer can already weaponize pty.spawn and git.exec to reach
// any path the SSH user can reach, so the FS-side allowlist provided friction
// without meaningfully narrowing the blast radius. See
// docs/relay-fs-allowlist-removal.md.
//
// registerRoot is retained as a no-op so existing session.registerRoot RPC
// calls (notification + request) remain valid during the relay-deploy upgrade
// window where an old main may still call into a new relay (and vice versa).
// Tracked for deletion once the relay-version floor moves past the cutover.
export class RelayContext {
  registerRoot(_rootPath: string): void {
    // intentionally empty
  }
}
