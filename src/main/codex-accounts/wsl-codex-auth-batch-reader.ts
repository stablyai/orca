import { runWslProcess } from '../wsl/wsl-runner'

export type WslCodexAuthRead =
  | { kind: 'missing' | 'unreadable' }
  | { kind: 'present'; contents: string }

export async function readWslCodexAuths(
  distro: string,
  linuxHomePaths: readonly string[]
): Promise<WslCodexAuthRead[]> {
  if (linuxHomePaths.length === 0) {
    return []
  }
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: READ_AUTHS_SCRIPT,
    args: linuxHomePaths,
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
  if (result.code !== 0 || result.timedOut) {
    return linuxHomePaths.map(() => ({ kind: 'unreadable' }))
  }
  const rows = result.stdout.split('\n')
  return linuxHomePaths.map((_, index) => parseAuthReadRow(rows[index] ?? ''))
}

export function decodeWslBase64Payload(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, 'base64')
    const canonical = decoded.toString('base64').replace(/=+$/, '')
    return canonical === encoded.replace(/=+$/, '') ? decoded.toString('utf8') : null
  } catch {
    return null
  }
}

function parseAuthReadRow(row: string): WslCodexAuthRead {
  if (row === 'missing' || row === 'unreadable') {
    return { kind: row }
  }
  if (!row.startsWith('present:')) {
    return { kind: 'unreadable' }
  }
  const contents = decodeWslBase64Payload(row.slice('present:'.length))
  return contents === null ? { kind: 'unreadable' } : { kind: 'present', contents }
}

const READ_AUTHS_SCRIPT = `
set -eu
for home_path in "$@"; do
  auth_path="$home_path/auth.json"
  if [ ! -f "$auth_path" ]; then
    if [ ! -e "$auth_path" ] && [ ! -L "$auth_path" ]; then
      printf 'missing\n'
    else
      printf 'unreadable\n'
    fi
    continue
  fi
  if encoded=$(base64 < "$auth_path"); then
    printf 'present:'
    printf '%s' "$encoded" | tr -d '\n'
    printf '\n'
  else
    printf 'unreadable\n'
  fi
done
`
