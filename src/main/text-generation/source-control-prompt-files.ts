import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUtf8ChunkEndIndex } from '../../shared/utf8-byte-limits'
import { encodePosixPrintfRecords } from '../../shared/posix-printf-encoding'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'

// Reserve the transport signature under the native text attachment cap.
const PAYLOAD_BYTES = 5 * 1024 * 1024 - 3

export function* promptFileContents(content: string): Generator<string> {
  for (let start = 0; start < content.length;) {
    const end = getUtf8ChunkEndIndex(content, start, PAYLOAD_BYTES)
    yield `\uFEFF${content.slice(start, end)}`
    start = end
  }
}

export function stageLocalPromptFiles(
  plan: CommitMessagePlan,
  own: (directory: string) => void
): CommitMessagePlan {
  if (!plan.promptFile) {
    return plan
  }
  const directory = mkdtempSync(join(tmpdir(), 'orca-generation-'))
  own(directory)
  const attachments: string[] = []
  for (const content of promptFileContents(plan.promptFile.content)) {
    const path = join(directory, `prompt-${attachments.length + 1}.txt`)
    writeFileSync(path, content, { mode: 0o600 })
    attachments.push(`@${path}`)
  }
  const args = [...plan.args]
  args.splice(plan.promptFile.argIndex, 1, ...attachments)
  return { ...plan, args }
}

// Preparation precedes profiles; only a proved empty allocation may roll back before ACK.
export const WSL_PROMPT_PREPARATION = `
nonce=$1; count=$2; shift 2
dir=/tmp/orca-generation-$nonce
old_umask=$(umask)
umask 077
mkdir "$dir" || exit 1
trap 'rmdir "$dir" 2>/dev/null' EXIT
printf '\\nORCA_GENERATION_READY:%s\\n' "$nonce" >&2 || exit 1
IFS= read -r record && [ "$record" = "A$nonce" ] || exit 1
trap - EXIT
index=1
while [ "$index" -le "$count" ]; do
  file=$dir/prompt-$index.txt
  : > "$file" || exit 1
  while :; do
    IFS= read -r record || exit 1
    case "$record" in
      D*) printf '%b' "\${record#D}" >> "$file" || exit 1 ;;
      *) [ "$record" = "F$nonce:$index" ] || exit 1; break ;;
    esac
  done
  index=$((index + 1))
done
IFS= read -r record && [ "$record" = "X$nonce" ] || exit 1
umask "$old_umask"
exec "$@" </dev/null
`

export function prepareWslPrompt(plan: CommitMessagePlan, distro: string) {
  const nonce = randomUUID()
  const directory = `/tmp/orca-generation-${nonce}`
  const attachments: string[] = []
  for (const _content of promptFileContents(plan.promptFile?.content ?? '')) {
    attachments.push(`@${directory}/prompt-${attachments.length + 1}.txt`)
  }
  const args = [...plan.args]
  args.splice(plan.promptFile?.argIndex ?? 0, 1, ...attachments)
  const proof = `ORCA_GENERATION_READY:${nonce}`
  let partial = ''
  let oversized = false
  let proved = false
  return {
    plan: { ...plan, args },
    preparation: { script: WSL_PROMPT_PREPARATION, args: [nonce, String(attachments.length)] },
    cleanupPath: toWindowsWslUncPath(directory, distro),
    observe(chunk: Buffer, diagnostic?: (bytes: Buffer) => void): boolean {
      let firstProof = false
      let passthrough = 0
      for (let index = 0; index < chunk.length; index++) {
        const byte = chunk[index]
        if (oversized) {
          const end = chunk.indexOf(10, index)
          if (end === -1) {
            diagnostic?.(chunk.subarray(passthrough))
            return firstProof
          }
          diagnostic?.(chunk.subarray(passthrough, end + 1))
          index = end
          oversized = false
        } else if (byte === 10) {
          if (partial === proof) {
            if (!proved) {
              proved = true
              firstProof = true
            }
          } else {
            diagnostic?.(Buffer.from(`${partial}\n`, 'latin1'))
          }
          partial = ''
        } else if (partial.length < proof.length && byte === proof.charCodeAt(partial.length)) {
          partial += String.fromCharCode(byte)
        } else {
          if (partial) {
            diagnostic?.(Buffer.from(partial, 'latin1'))
          }
          partial = ''
          oversized = true
          passthrough = index
          index--
        }
        if (!oversized) {
          passthrough = index + 1
        }
      }
      return firstProof
    },
    *records(): Generator<string> {
      yield `A${nonce}\n`
      let index = 0
      for (const content of promptFileContents(plan.promptFile?.content ?? '')) {
        for (const encoded of encodePosixPrintfRecords(content)) {
          yield `D${encoded}\n`
        }
        yield `F${nonce}:${++index}\n`
      }
      yield `X${nonce}\n`
    }
  }
}
