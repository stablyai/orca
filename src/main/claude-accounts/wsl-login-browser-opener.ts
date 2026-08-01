import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { quoteBashString } from '../wsl-bash-command'

export const WSL_LOGIN_OPENER_DIR = 'orca-opener'
export const WSL_LOGIN_OPENER_HANDOFF = 'open-url.request'
export const WSL_LOGIN_OPENER_POLL_MS = 200
export const WSL_LOGIN_OPENER_MAX_URL_CHARS = 2048

export function buildWslLoginOpenerShellScript(): string {
  return `#!/bin/sh
[ -n "\${ORCA_CLAUDE_OPENER_SELFTEST:-}" ] && exit 0
[ $# -ge 1 ] || exit 1
dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp="$dir/${WSL_LOGIN_OPENER_HANDOFF}.$$"
printf '%s' "$1" > "$tmp" || exit 1
mv -f "$tmp" "$dir/${WSL_LOGIN_OPENER_HANDOFF}" || exit 1
exit 0
`
}

export function buildWslLoginConfigDirScript(): string {
  return `set -eu
dir="$(mktemp -d "\${TMPDIR:-/tmp}/orca-claude-login.XXXXXX")"
cleanup() { rm -rf -- "$dir"; }
trap cleanup EXIT
mkdir -p "$dir/${WSL_LOGIN_OPENER_DIR}"
cat > "$dir/${WSL_LOGIN_OPENER_DIR}/xdg-open" <<'ORCA_CLAUDE_OPENER'
${buildWslLoginOpenerShellScript()}ORCA_CLAUDE_OPENER
chmod 700 "$dir/${WSL_LOGIN_OPENER_DIR}/xdg-open"
ln -s xdg-open "$dir/${WSL_LOGIN_OPENER_DIR}/wslview" 2>/dev/null || true
ORCA_CLAUDE_OPENER_SELFTEST=1 "$dir/${WSL_LOGIN_OPENER_DIR}/xdg-open" selftest
trap - EXIT
printf 'ORCA_CLAUDE_LOGIN_DIR=%s\\n' "$dir"
`
}

export function buildWslLoginPathExport(linuxTempDir: string): string {
  return `export PATH="$PATH:${quoteBashString(`${linuxTempDir}/${WSL_LOGIN_OPENER_DIR}`)}"; `
}

export function parseWslLoginConfigDirOutput(raw: string): string | null {
  const lines = raw.replaceAll(String.fromCharCode(0), '').split(/\r?\n/)
  const marker = 'ORCA_CLAUDE_LOGIN_DIR='
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(marker)) {
      const path = lines[index].slice(marker.length).trim()
      return path.startsWith('/') ? path : null
    }
  }
  return null
}

export function parseWslLoginOpenerHandoff(raw: string): string | null {
  const trimmed = raw.trim()
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
  if (
    trimmed.length === 0 ||
    trimmed.length > WSL_LOGIN_OPENER_MAX_URL_CHARS ||
    hasControlCharacter
  ) {
    return null
  }
  const normalized = normalizeExternalBrowserUrl(trimmed)
  if (!normalized) {
    return null
  }
  try {
    return new URL(normalized).protocol === 'https:' ? normalized : null
  } catch {
    return null
  }
}

export function createWslLoginOpenerHandoff(args: {
  windowsConfigDir: string
  onUrl: (url: string) => void | Promise<void>
  onInvalid: () => void
  pollMs?: number
}): { stop: () => void } {
  const handoffPath = join(args.windowsConfigDir, WSL_LOGIN_OPENER_HANDOFF)
  let stopped = false
  const timer = setInterval(() => {
    if (stopped || !existsSync(handoffPath)) {
      return
    }
    let raw: string
    try {
      raw = readFileSync(handoffPath, 'utf8')
    } catch {
      return
    }
    stopped = true
    clearInterval(timer)
    try {
      rmSync(handoffPath, { force: true })
    } catch {
      // Temporary-directory cleanup remains authoritative.
    }
    const url = parseWslLoginOpenerHandoff(raw)
    if (url) {
      void args.onUrl(url)
    } else {
      args.onInvalid()
    }
  }, args.pollMs ?? WSL_LOGIN_OPENER_POLL_MS)
  return {
    stop: () => {
      if (!stopped) {
        stopped = true
        clearInterval(timer)
      }
    }
  }
}

export function openWslLoginAuthorizationUrl(url: string): Promise<void> {
  return shell.openExternal(url)
}
