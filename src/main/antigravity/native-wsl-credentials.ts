import { createHash } from 'node:crypto'
import { decodeWslBase64Payload } from '../codex-accounts/runtime-home/wsl/wsl-codex-auth-batch-reader'
import { readWslDistroRunningState } from '../wsl/discovery/wsl-background-distro-gate'
import { runWslProcess, type WslSpec } from '../wsl/execution/wsl-runner'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import type { AntigravityCredentialBackend } from './native-account-service'

const CONFLICT =
  'The native Antigravity credential changed during selection; refresh before retrying.'
const CONFLICT_EXIT = 3

// agy inside WSL always uses its file store (it detects WSL like isAntigravityFileStorageHost).
const FILE = '"$HOME/.gemini/antigravity-cli/antigravity-oauth-token"'

// Same safety bar as the host file reader: a private regular file no larger than 64 KiB.
const READ_SCRIPT = `
f=${FILE}
if [ -L "$f" ]; then echo unsafe; exit 0; fi
if [ ! -e "$f" ]; then echo missing; exit 0; fi
if [ ! -f "$f" ]; then echo unsafe; exit 0; fi
mode=$(stat -c %a -- "$f") && size=$(stat -c %s -- "$f") || { echo unsafe; exit 0; }
case "$mode" in *00) ;; *) echo unsafe; exit 0 ;; esac
if [ "$size" -gt 65536 ]; then echo unsafe; exit 0; fi
encoded=$(base64 < "$f") || { echo unsafe; exit 0; }
printf 'present:%s\\n' "$encoded" | tr -d '\\n'
`

// Compare-and-swap inside the guest: $1 is the expected file's sha256, or - for none.
const WRITE_SCRIPT = `
set -eu
f=${FILE}
current=-
if [ -e "$f" ] || [ -L "$f" ]; then
  if [ -L "$f" ] || [ ! -f "$f" ]; then exit ${CONFLICT_EXIT}; fi
  current=$(sha256sum < "$f" | cut -d ' ' -f 1)
fi
[ "$current" = "$1" ] || exit ${CONFLICT_EXIT}
umask 077
dir=$(dirname -- "$f")
mkdir -p -- "$dir"
tmp=$(mktemp "$dir/.antigravity-oauth-token.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
chmod 600 "$tmp"
mv -f -- "$tmp" "$f"
trap - EXIT
`

type WslCredentialDeps = {
  runningState: (distro: string) => Promise<'running' | 'stopped' | 'unverifiable'>
  run: (spec: WslSpec) => Promise<{ code: number | null; stdout: string; timedOut: boolean }>
}

const defaultDeps: WslCredentialDeps = {
  runningState: (distro) => readWslDistroRunningState(distro),
  run: runWslProcess
}

/** agy's credential file inside one WSL distro; never starts the distro to read or write it. */
export function createAntigravityWslCredentialBackend(
  distro: string,
  deps: WslCredentialDeps = defaultDeps
): AntigravityCredentialBackend {
  const label = `WSL (${distro})`
  async function guest(
    spec: Pick<WslSpec, 'args' | 'input' | 'maxOutputBytes'> & { script: string }
  ) {
    const state = await deps.runningState(distro)
    if (state !== 'running') {
      throw new Error(
        state === 'stopped'
          ? `${label} is not running. Start it, then refresh Antigravity accounts.`
          : `Orca could not confirm that ${label} is running. Refresh Antigravity accounts to try again.`
      )
    }
    return deps.run({ ...spec, distro, loginPath: 'none', timeoutMs: 10_000 })
  }

  async function read() {
    const result = await guest({
      script: READ_SCRIPT,
      maxOutputBytes: 128 * 1024
    })
    const row = result.stdout.trim()
    if (result.code === 0 && !result.timedOut && row === 'missing') {
      return null
    }
    const contents =
      result.code === 0 && !result.timedOut && row.startsWith('present:')
        ? decodeWslBase64Payload(row.slice('present:'.length))
        : null
    if (contents === null) {
      throw new Error(`The Antigravity credential file in ${label} could not be read safely.`)
    }
    return parseAntigravityNativeCredential(contents)
  }

  return {
    read,
    async write(contents, expected) {
      parseAntigravityNativeCredential(contents)
      const expectedHash =
        expected === null ? '-' : createHash('sha256').update(expected, 'utf8').digest('hex')
      const result = await guest({
        script: WRITE_SCRIPT,
        args: [expectedHash],
        input: contents
      })
      if (result.code === CONFLICT_EXIT) {
        throw new Error(CONFLICT)
      }
      if (result.code !== 0 || result.timedOut) {
        throw new Error(`Antigravity could not update its credential file in ${label}.`)
      }
      if ((await read())?.contents !== contents) {
        throw new Error(CONFLICT)
      }
    }
  }
}
