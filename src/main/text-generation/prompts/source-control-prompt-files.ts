import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUtf8ChunkEndIndex } from '../../../shared/utf8-byte-limits'
import { encodePosixPrintfRecords } from '../../../shared/posix-printf-encoding'
import { toWindowsWslUncPath } from '../../../shared/wsl-paths'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'

// Reserve the transport signature under the native text attachment cap.
const PAYLOAD_BYTES = 5 * 1024 * 1024 - 3
export const TEXT_TASK_DIRECTORY = '__ORCA_TEXT_TASK_DIRECTORY__'

function generationFiles(plan: CommitMessagePlan) {
  const files: {
    name: string
    content: string
    argIndex?: number
    attachment?: boolean
    interpolateDirectory?: boolean
  }[] = []
  if (plan.promptFile) {
    for (const content of promptFileContents(plan.promptFile.content)) {
      files.push({
        name: `prompt-${files.length + 1}.txt`,
        content,
        argIndex: plan.promptFile.argIndex,
        attachment: true
      })
    }
  }
  for (const file of plan.taskFiles ?? []) {
    if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(file.name)) {
      throw new Error('Invalid text task artifact name')
    }
    files.push(file)
  }
  return files
}

function materializedPlan(
  plan: CommitMessagePlan,
  directory: string,
  files: ReturnType<typeof generationFiles>
) {
  const substitutions = new Map<number, string[]>()
  if (plan.promptFile) {
    substitutions.set(plan.promptFile.argIndex, [])
  }
  for (const file of files) {
    if (file.argIndex === undefined) {
      continue
    }
    const path = `${directory}/${file.name}`
    const values = substitutions.get(file.argIndex) ?? []
    values.push(file.attachment ? `@${path}` : path)
    substitutions.set(file.argIndex, values)
  }
  const args = [...plan.args]
  for (const [index, values] of [...substitutions].sort(([left], [right]) => right - left)) {
    args.splice(index, 1, ...values)
  }
  return { ...plan, args }
}

function policyContent(
  file: ReturnType<typeof generationFiles>[number],
  directory: string
): string {
  return file.interpolateDirectory
    ? file.content.replaceAll(
        TEXT_TASK_DIRECTORY,
        JSON.stringify(directory.replaceAll('\\', '/')).slice(1, -1)
      )
    : file.content
}

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
  const files = generationFiles(plan)
  if (!files.length && !plan.promptFile) {
    return plan
  }
  const directory = mkdtempSync(join(tmpdir(), 'orca-generation-'))
  own(directory)
  for (const file of files) {
    writeFileSync(join(directory, file.name), policyContent(file, directory), { mode: 0o600 })
  }
  return materializedPlan(plan, directory, files)
}

// Preparation precedes profiles; only a proved empty allocation may roll back before ACK.
export const WSL_PROMPT_PREPARATION = `
nonce=$1; count=$2; shift 2
custom_names=0
if [ "\${1-}" = --task-files ]; then custom_names=1; shift; fi
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
  if [ "$custom_names" = 1 ]; then file=$dir/$1; shift; else file=$dir/prompt-$index.txt; fi
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
exec "$@"
`

export function prepareWslPrompt(plan: CommitMessagePlan, distro: string) {
  const nonce = randomUUID()
  const directory = `/tmp/orca-generation-${nonce}`
  const files = generationFiles(plan)
  const proof = `ORCA_GENERATION_READY:${nonce}`
  let partial = ''
  let oversized = false
  let proved = false
  return {
    plan: materializedPlan(plan, directory, files),
    preparation: {
      script: WSL_PROMPT_PREPARATION,
      args: [
        nonce,
        String(files.length),
        ...(plan.taskFiles?.length ? ['--task-files', ...files.map((file) => file.name)] : [])
      ]
    },
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
      for (const file of files) {
        for (const encoded of encodePosixPrintfRecords(policyContent(file, directory))) {
          yield `D${encoded}\n`
        }
        yield `F${nonce}:${++index}\n`
      }
      yield `X${nonce}\n`
      if (plan.stdinPayload) {
        yield plan.stdinPayload
      }
    }
  }
}
