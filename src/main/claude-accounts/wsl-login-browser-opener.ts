import { closeSync, existsSync, openSync, readSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import { quoteBashString } from '../wsl-bash-command'

export const WSL_LOGIN_OPENER_DIR = 'orca-opener'
export const WSL_LOGIN_OPENER_HANDOFF = 'open-url.request'
export const WSL_LOGIN_OPENER_POLL_MS = 200
export const WSL_LOGIN_OPENER_MAX_URL_CHARS = 2048
const WSL_LOGIN_OPENER_MAX_URL_BYTES = WSL_LOGIN_OPENER_MAX_URL_CHARS * 4
const WSL_LOGIN_AUTHORIZATION_HOSTS = new Set([
  'claude.com',
  'platform.claude.com',
  'console.anthropic.com',
  'anthropic.com'
])

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
${buildWslLoginOpenerShellScript()}
ORCA_CLAUDE_OPENER
chmod 700 "$dir/${WSL_LOGIN_OPENER_DIR}/xdg-open"
ln -s xdg-open "$dir/${WSL_LOGIN_OPENER_DIR}/wslview" 2>/dev/null || true
ORCA_CLAUDE_OPENER_SELFTEST=1 "$dir/${WSL_LOGIN_OPENER_DIR}/xdg-open" selftest
trap - EXIT
printf 'ORCA_CLAUDE_LOGIN_DIR=%s\\n' "$dir"
`
}

export function buildWslLoginPathExport(linuxTempDir: string): string {
  return `export PATH="$PATH":${quoteBashString(`${linuxTempDir}/${WSL_LOGIN_OPENER_DIR}`)}; `
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
    Buffer.byteLength(trimmed, 'utf8') > WSL_LOGIN_OPENER_MAX_URL_BYTES ||
    hasControlCharacter
  ) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    const authority = trimmed.slice('https://'.length).split(/[/?#]/, 1)[0]
    if (
      parsed.protocol !== 'https:' ||
      !WSL_LOGIN_AUTHORIZATION_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      authority.toLowerCase() !== parsed.hostname.toLowerCase() ||
      parsed.hash !== ''
    ) {
      return null
    }
    return trimmed
  } catch {
    return null
  }
}

function readWslLoginOpenerHandoff(path: string): string {
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(WSL_LOGIN_OPENER_MAX_URL_BYTES + 1)
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function createWslLoginOpenerHandoff(args: {
  windowsConfigDir: string
  onUrl: (url: string) => void | Promise<void>
  onInvalid: () => void
  onReadError: () => void
  pollMs?: number
}): { stop: () => void } {
  const handoffPath = join(args.windowsConfigDir, WSL_LOGIN_OPENER_HANDOFF)
  let stopped = false
  const timer = setInterval(() => {
    if (stopped || !existsSync(handoffPath)) {
      return
    }
    const claimedPath = `${handoffPath}.consumed`
    try {
      renameSync(handoffPath, claimedPath)
    } catch {
      return
    }
    stopped = true
    clearInterval(timer)
    let raw: string | null = null
    try {
      raw = readWslLoginOpenerHandoff(claimedPath)
    } catch {
      args.onReadError()
    }
    let cleanupFailed = false
    try {
      rmSync(claimedPath, { force: true })
    } catch {
      cleanupFailed = true
    }
    if (cleanupFailed) {
      if (raw !== null) {
        args.onReadError()
      }
      return
    }
    if (raw === null) {
      return
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
