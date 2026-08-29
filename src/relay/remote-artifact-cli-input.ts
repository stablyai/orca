import { basename, extname, resolve } from 'node:path'
import type { RemoteArtifactInput } from '../shared/artifact-cli-bridge'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../shared/artifacts'
import { readArtifactFileWithinLimit } from '../shared/artifact-file-read'
import { MAX_MESSAGE_SIZE } from './protocol'

export type PreparedRemoteArtifactCliInput = {
  stdin?: string
  artifactInput?: RemoteArtifactInput
}

const BOOLEAN_FLAGS = new Set(['help', 'json'])
const VALUE_FLAGS = new Set(['api-url', 'environment', 'file', 'pairing-code'])

function parseArtifactInvocation(argv: string[]): { command: string; file?: string } | null {
  const positionals: string[] = []
  let file: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const assignment = token.slice(2)
    const equalsIndex = assignment.indexOf('=')
    const flag = equalsIndex === -1 ? assignment : assignment.slice(0, equalsIndex)
    if (flag === 'file' && equalsIndex !== -1) {
      file = assignment.slice(equalsIndex + 1)
      continue
    }
    if (equalsIndex !== -1 || BOOLEAN_FLAGS.has(flag)) {
      continue
    }
    if (VALUE_FLAGS.has(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      if (flag === 'file') {
        file = argv[index + 1]
      }
      index += 1
    }
  }
  if (positionals[0] !== 'artifacts' || !['share', 'update', 'unshare'].includes(positionals[1])) {
    return null
  }
  return { command: positionals[1], file: file ?? positionals[2] }
}

function contentTypeForPath(path: string): NonNullable<RemoteArtifactInput['contentType']> | null {
  const extension = extname(path).toLowerCase()
  return ['.html', '.htm'].includes(extension)
    ? 'text/html'
    : ['.md', '.markdown'].includes(extension)
      ? 'text/markdown'
      : null
}

export async function prepareRemoteArtifactCliInput(
  argv: string[],
  cwd: string
): Promise<PreparedRemoteArtifactCliInput> {
  const invocation = parseArtifactInvocation(argv)
  if (!invocation || argv.includes('--help')) {
    return {}
  }
  if (!invocation.file) {
    return {}
  }
  const sourceKey = resolve(cwd, invocation.file)
  if (invocation.command === 'unshare') {
    return { artifactInput: { sourceKey, fileName: basename(sourceKey) } }
  }
  const contentType = contentTypeForPath(sourceKey)
  if (!contentType) {
    throw new Error('Artifacts must be HTML or Markdown files.')
  }
  const result = await readArtifactFileWithinLimit(sourceKey, ARTIFACT_CLI_MAX_RPC_BYTES)
  if (result.status === 'not-file') {
    throw new Error('Artifact file was not found or is not a file.')
  }
  if (result.status === 'too-large') {
    throw new Error(
      'Artifact is too large for the Orca CLI transport. Use the browser upload page instead.'
    )
  }
  if (result.status === 'empty') {
    throw new Error('Artifact file is empty.')
  }
  const prepared = {
    stdin: result.content,
    artifactInput: { sourceKey, fileName: basename(sourceKey), contentType }
  }
  if (Buffer.byteLength(JSON.stringify(prepared), 'utf8') > MAX_MESSAGE_SIZE - 64 * 1024) {
    throw new Error('Artifact content exceeds the SSH relay message limit.')
  }
  return prepared
}
